import { posix } from "node:path"

/** Sorted, disjoint inclusive [start, end] ranges of diff line numbers. */
export type DiffLineRanges = Array<[number, number]>

/** Canonical file inventory and anchors, retained even when model text is compacted. */
export type DiffFile = {
  path: string
  status: "added" | "modified" | "removed"
  addedLines: DiffLineRanges
  deletedLines: DiffLineRanges
  rightLines: DiffLineRanges
  leftLines: DiffLineRanges
}

/** Comment validation uses inclusive ranges, including in serialized snapshots. */
export type ValidCommentRanges = Record<
  string,
  {
    added_lines: DiffLineRanges
    deleted_lines: DiffLineRanges
    right_lines: DiffLineRanges
    left_lines: DiffLineRanges
  }
>

const IGNORED_LOCKFILES = new Set([
  ".terraform.lock.hcl",
  "bun.lock",
  "bun.lockb",
  "cabal.project.freeze",
  "cargo.lock",
  "composer.lock",
  "conan.lock",
  "conda-lock.yml",
  "conda-lock.yaml",
  "deno.lock",
  "flake.lock",
  "gemfile.lock",
  "go.sum",
  "gradle.lockfile",
  "mix.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.resolved",
  "packages.lock.json",
  "paket.lock",
  "pdm.lock",
  "pipfile.lock",
  "pixi.lock",
  "pnpm-lock.yaml",
  "podfile.lock",
  "poetry.lock",
  "pubspec.lock",
  "requirements.lock",
  "stack.yaml.lock",
  "uv.lock",
  "yarn.lock"
])

/** Counts covered lines without expanding compact ranges into line arrays. */
export function countDiffLines(ranges: DiffLineRanges): number {
  return ranges.reduce((count, [start, end]) => count + end - start + 1, 0)
}

/** Tests an entire inclusive range; separated hunks cannot bridge missing lines. */
export function containsDiffRange(ranges: DiffLineRanges, start: number, end = start): boolean {
  if (end < start) return false
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const range = ranges[middle]
    if (!range) return false
    const [first, last] = range
    if (start < first) high = middle - 1
    else if (start > last) low = middle + 1
    else return end <= last
  }
  return false
}

/**
 * Records one line in an interval list. Hunk counters advance monotonically
 * within a file, so normal patches extend the open interval or start a new
 * one without per-line hash entries. Out-of-order blocks use a rare merge path.
 */
function recordLine(intervals: DiffLineRanges, line: number): void {
  const last = intervals[intervals.length - 1]
  if (last && line >= last[0] && line <= last[1]) {
    return
  }
  if (last && line === last[1] + 1) {
    last[1] = line
    return
  }
  if (!last || line > last[1]) {
    intervals.push([line, line])
    return
  }
  // Repeated or hand-crafted blocks can restart before the last hunk. Merge
  // those rare insertions rather than silently dropping earlier anchors.
  let index = 0
  let next = intervals[index]
  while (next && next[1] < line - 1) {
    index += 1
    next = intervals[index]
  }
  if (!next) {
    intervals.push([line, line])
    return
  }
  if (line < next[0] - 1) intervals.splice(index, 0, [line, line])
  else {
    next[0] = Math.min(next[0], line)
    next[1] = Math.max(next[1], line)
    const following = intervals[index + 1]
    if (following && following[0] <= next[1] + 1) {
      next[1] = following[1]
      intervals.splice(index + 1, 1)
    }
  }
}

/**
 * Owns the two deterministic diff policies the reviewer needs: removing
 * generated/binary noise from model context and calculating valid GitHub
 * review-comment anchors from the remaining hunks.
 */
export class ReviewDiff {
  readonly text: string
  readonly ignoredFiles: string[]
  readonly files: DiffFile[]
  readonly commentRanges: ValidCommentRanges

  private constructor(text: string, ignoredFiles: string[], files: DiffFile[]) {
    this.text = text
    this.ignoredFiles = ignoredFiles
    this.files = files
    this.commentRanges = Object.fromEntries(
      files.map(file => [
        file.path,
        {
          added_lines: file.addedLines,
          deleted_lines: file.deletedLines,
          right_lines: file.rightLines,
          left_lines: file.leftLines
        }
      ])
    )
  }

  /**
   * Parses complete evidence for anchors and inventory. An optional Git -D
   * projection omits deleted bodies from model context without losing anchors.
   */
  static from(rawDiff: string, modelDiff?: string): ReviewDiff {
    const raw = ReviewDiff.filterBlocks(rawDiff)
    // Anchors come from the complete patch. Parsing the kept blocks directly
    // avoids joining them into a second full-size string only to split it
    // again, which matters when a large PR's raw diff is tens of megabytes.
    const files = ReviewDiff.parseFiles(raw.blocks)
    if (modelDiff === undefined) {
      return new ReviewDiff(ReviewDiff.joinBlocks(raw.blocks, rawDiff), raw.ignoredFiles, files)
    }
    const model = ReviewDiff.filterBlocks(modelDiff, raw.ignoredFiles)
    return new ReviewDiff(ReviewDiff.joinBlocks(model.blocks, modelDiff), raw.ignoredFiles, files)
  }

  /**
   * Drops lockfile and binary blocks only. Deletion-body compaction belongs to
   * the separate model projection, not this filter.
   */
  private static filterBlocks(
    rawDiff: string,
    excludedFiles: string[] = []
  ): { blocks: string[]; ignoredFiles: string[] } {
    // Keep file-sized slices rather than a string object for every raw line.
    // Git emits LF; normalize CRLF only when an API/caller supplied it.
    const normalized = rawDiff.includes("\r\n") ? rawDiff.replace(/\r\n/gu, "\n") : rawDiff
    const blocks: string[] = []
    let start = 0
    for (const header of normalized.matchAll(/^diff --git /gmu)) {
      if (header.index > start) blocks.push(normalized.slice(start, header.index - 1))
      start = header.index
    }
    blocks.push(normalized.slice(start))

    const ignored = new Set(excludedFiles)
    const kept = blocks.filter(block => {
      const paths = ReviewDiff.paths(ReviewDiff.lines(block))
      // Git -D also removes binary markers. Carry exclusions from the complete
      // patch so compact deletion headers cannot reintroduce ignored files.
      if (paths.some(path => ignored.has(path))) return false
      const lockfiles = paths.filter(path => IGNORED_LOCKFILES.has(posix.basename(path).toLowerCase()))
      const binary = /(?:^|\n)(?:GIT binary patch(?:\n|$)|Binary files )/u.test(block)
      if (lockfiles.length === 0 && !binary) {
        return true
      }
      for (const path of lockfiles.length > 0 ? lockfiles : paths) {
        ignored.add(path)
      }
      return false
    })

    return { blocks: kept, ignoredFiles: [...ignored].sort() }
  }

  /** Reassembles kept blocks, preserving the source's trailing newline. */
  private static joinBlocks(blocks: string[], rawDiff: string): string {
    const text = blocks.join("\n")
    return /\r?\n$/u.test(rawDiff) && text ? `${text}\n` : text
  }

  /** Iterates patch lines without retaining a full array of line-sized strings. */
  private static *lines(block: string): Generator<string> {
    let start = 0
    let end: number
    while ((end = block.indexOf("\n", start)) !== -1) {
      yield block.slice(start, end)
      start = end + 1
    }
    yield block.slice(start)
  }

  /**
   * Walks hunk line counters exactly as GitHub does. Changed ranges decide
   * whether a comment may end on a line; LEFT/RIGHT ranges validate its span.
   */
  private static parseFiles(blocks: string[]): DiffFile[] {
    const files = new Map<string, DiffFile>()
    let path: string | null = null
    let oldPath: string | null = null
    let newPath: string | null = null
    let oldLine = 0
    let newLine = 0
    let inHunk = false

    const file = (filePath: string, status: DiffFile["status"]): DiffFile => {
      const existing = files.get(filePath)
      if (existing) {
        return existing
      }
      const created: DiffFile = {
        path: filePath,
        status,
        addedLines: [],
        deletedLines: [],
        rightLines: [],
        leftLines: []
      }
      files.set(filePath, created)
      return created
    }

    for (const block of blocks) {
      // Explicit path/rename headers disambiguate ordinary filenames with
      // spaces before seeding hunk-less changes into the inventory.
      const [headerOldPath = null, headerNewPath = null] = ReviewDiff.paths(ReviewDiff.lines(block))
      for (const line of ReviewDiff.lines(block)) {
        if (line.startsWith("diff --git ")) {
          // A pure rename or empty-file change has no hunk and may omit ---/+++.
          // Seed its inventory entry from the block header before parsing lines.
          oldPath = headerOldPath
          newPath = headerNewPath
          path = newPath || oldPath
          if (path) file(path, "modified")
          inHunk = false
          continue
        }
        if (line.startsWith("new file mode ") && path) {
          file(path, "added").status = "added"
          continue
        }
        if (line.startsWith("deleted file mode ") && path) {
          file(path, "removed").status = "removed"
          continue
        }
        // SQL comments and other source lines can look like ---/+++ headers
        // inside a hunk; they must advance the normal deleted/added counters.
        if (!inHunk && line.startsWith("--- ")) {
          oldPath = ReviewDiff.normalizePath(line.slice(4))
          path = newPath || oldPath
          inHunk = false
          continue
        }
        if (!inHunk && line.startsWith("+++ ")) {
          newPath = ReviewDiff.normalizePath(line.slice(4))
          path = newPath || oldPath
          inHunk = false
          continue
        }
        if (line.startsWith("@@ ")) {
          const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?/u.exec(line)
          inHunk = Boolean(hunk)
          oldLine = hunk ? Number(hunk[1]) - 1 : 0
          newLine = hunk ? Number(hunk[2]) - 1 : 0
          continue
        }
        if (!inHunk || !path || line.startsWith("\\")) {
          continue
        }

        // `/dev/null` on one side is the canonical unified-diff signal for file
        // creation or deletion; all other hunks are grouped as modifications.
        const status = oldPath === null ? "added" : newPath === null ? "removed" : "modified"
        const lines = file(path, status)
        lines.status = status
        if (line.startsWith(" ")) {
          oldLine += 1
          newLine += 1
          recordLine(lines.leftLines, oldLine)
          recordLine(lines.rightLines, newLine)
        } else if (line.startsWith("-")) {
          oldLine += 1
          recordLine(lines.leftLines, oldLine)
          recordLine(lines.deletedLines, oldLine)
        } else if (line.startsWith("+")) {
          newLine += 1
          recordLine(lines.rightLines, newLine)
          recordLine(lines.addedLines, newLine)
        }
      }
    }
    return [...files.values()]
  }

  /** Extracts old and new paths from one diff block, including quoted names. */
  private static paths(lines: Iterable<string>): string[] {
    let oldPath: string | null = null
    let newPath: string | null = null
    for (const line of lines) {
      // Paths belong to the block header, never to header-like source text.
      if (line.startsWith("@@ ")) break
      if (line.startsWith("diff --git ")) {
        const header = line.slice("diff --git ".length)
        const middle = (header.length - 1) / 2
        // Git leaves spaces unquoted. Add/delete/modify headers repeat the
        // same path; comparing the two halves avoids splitting that name.
        if (header.startsWith("a/") && header.slice(middle + 1) === "b/" + header.slice(2, middle)) {
          oldPath = newPath = header.slice(2, middle)
        } else {
          const values = header.match(/"(?:\\.|[^"])*"|\S+/gu)?.slice(0, 2)
          oldPath = ReviewDiff.normalizePath(values?.[0] || "")
          newPath = ReviewDiff.normalizePath(values?.[1] || "")
        }
      } else if (line.startsWith("--- ")) {
        oldPath = ReviewDiff.normalizePath(line.slice(4))
      } else if (line.startsWith("+++ ")) {
        newPath = ReviewDiff.normalizePath(line.slice(4))
      } else if (line.startsWith("rename from ")) {
        oldPath = ReviewDiff.decodePath(line.slice("rename from ".length))
      } else if (line.startsWith("rename to ")) {
        newPath = ReviewDiff.decodePath(line.slice("rename to ".length))
      }
    }
    return [oldPath, newPath].filter((path): path is string => path !== null)
  }

  /** Removes git's a/b prefixes and excludes /dev/null creation metadata. */
  private static normalizePath(raw: string): string | null {
    // Unified path headers may append a tab delimiter or timestamp. Quoted
    // filenames encode actual tabs as escapes; unquoted spaces are significant.
    raw = ReviewDiff.decodePath(raw.split("\t", 1)[0] || "")
    if (!raw || raw === "/dev/null") {
      return null
    }
    return raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw
  }

  /** Decodes Git's C-quoted paths, where octal escapes encode UTF-8 bytes. */
  private static decodePath(raw: string): string {
    if (!raw.startsWith('"') || !raw.endsWith('"')) return raw
    const controls: Record<string, string> = {
      a: "\x07",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      '"': '"'
    }
    const bytes: Buffer[] = []
    for (const part of raw.slice(1, -1).matchAll(/\\([0-7]{1,3}|[abfnrtv\\"])|[^\\]+|\\/gu)) {
      const escaped = part[1]
      bytes.push(
        escaped === undefined
          ? Buffer.from(part[0])
          : /^[0-7]/u.test(escaped)
            ? Buffer.from([Number.parseInt(escaped, 8)])
            : Buffer.from(controls[escaped] || escaped)
      )
    }
    return Buffer.concat(bytes).toString("utf8")
  }
}
