import { type ParsedDiff, type ValidCommentRanges } from "./types.js"

/**
 * Normalizes unified-diff paths into repository-relative paths. `/dev/null`
 * marks file creation/deletion metadata rather than a commentable file path.
 */
export function normalizeDiffPath(rawPath: string): string | null {
  if (!rawPath || rawPath === "/dev/null") {
    return null
  }

  if (rawPath.startsWith("a/") || rawPath.startsWith("b/")) {
    return rawPath.slice(2)
  }

  return rawPath
}

const IGNORED_LOCKFILE_NAMES = new Set([
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

const IGNORED_BINARY_EXTENSIONS = new Set([
  ".7z",
  ".aac",
  ".a",
  ".ai",
  ".apk",
  ".avi",
  ".avif",
  ".bin",
  ".blend",
  ".bmp",
  ".br",
  ".bz2",
  ".class",
  ".dat",
  ".db",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".dylib",
  ".ear",
  ".eot",
  ".exe",
  ".fig",
  ".flac",
  ".gem",
  ".gif",
  ".gz",
  ".heic",
  ".heif",
  ".ico",
  ".ipa",
  ".iso",
  ".jar",
  ".jpeg",
  ".jpg",
  ".key",
  ".lib",
  ".m4a",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".numbers",
  ".o",
  ".obj",
  ".oga",
  ".ogg",
  ".otf",
  ".pages",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".psd",
  ".pyc",
  ".pyo",
  ".rar",
  ".safetensors",
  ".sketch",
  ".so",
  ".sqlite",
  ".sqlite3",
  ".svg",
  ".svgz",
  ".tar",
  ".tbz2",
  ".tgz",
  ".tif",
  ".tiff",
  ".ttf",
  ".txz",
  ".wasm",
  ".wav",
  ".webm",
  ".webp",
  ".whl",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".xz",
  ".zip",
  ".zst"
])

export function isPackageLockPath(filePath: string | null): boolean {
  return Boolean(filePath && /(?:^|\/)package-lock\.json$/u.test(filePath))
}

function basename(filePath: string): string {
  const slash = filePath.lastIndexOf("/")
  return slash >= 0 ? filePath.slice(slash + 1) : filePath
}

function extension(filePath: string): string {
  const name = basename(filePath)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot).toLowerCase() : ""
}

export function isIgnoredReviewDiffPath(filePath: string | null): boolean {
  if (!filePath) {
    return false
  }

  const name = basename(filePath).toLowerCase()
  return IGNORED_LOCKFILE_NAMES.has(name) || IGNORED_BINARY_EXTENSIONS.has(extension(filePath))
}

function diffHeaderTokens(text: string): string[] {
  const tokens: string[] = []
  let index = 0

  while (index < text.length) {
    while (text[index] === " ") {
      index += 1
    }

    if (index >= text.length) {
      break
    }

    if (text[index] === '"') {
      index += 1
      let token = ""
      while (index < text.length) {
        const char = text[index]
        if (char === '"') {
          index += 1
          break
        }
        if (char === "\\" && index + 1 < text.length) {
          token += text[index + 1]
          index += 2
          continue
        }
        token += char
        index += 1
      }
      tokens.push(token)
      continue
    }

    const start = index
    while (index < text.length && text[index] !== " ") {
      index += 1
    }
    tokens.push(text.slice(start, index))
  }

  return tokens
}

function pathsFromDiffGitLine(line: string): string[] {
  const prefix = "diff --git "
  if (!line.startsWith(prefix)) {
    return []
  }

  return diffHeaderTokens(line.slice(prefix.length))
    .slice(0, 2)
    .map(normalizeDiffPath)
    .filter((filePath): filePath is string => Boolean(filePath))
}

function pathsFromDiffBlock(lines: string[]): string[] {
  const paths = new Set<string>()

  for (const line of lines) {
    for (const filePath of pathsFromDiffGitLine(line)) {
      paths.add(filePath)
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const filePath = normalizeDiffPath(line.slice(4).trim())
      if (filePath) {
        paths.add(filePath)
      }
    }
  }

  return Array.from(paths)
}

function isBinaryDiffBlock(lines: string[]): boolean {
  return lines.some(line => line === "GIT binary patch" || line.startsWith("Binary files "))
}

/**
 * Removes high-noise generated lockfile, media, archive, and binary hunks from
 * the diff shown to models. The checked-out repository still contains the file,
 * so reviewers can inspect it with git when those changes are materially relevant.
 */
export function filterReviewDiff(diffText: string): { text: string; ignoredFiles: string[] } {
  const lines = diffText.split(/\r?\n/u)
  const blocks: string[][] = []
  let current: string[] = []

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      blocks.push(current)
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) {
    blocks.push(current)
  }

  const ignoredFiles = new Set<string>()
  const kept = blocks.filter(block => {
    const paths = pathsFromDiffBlock(block)
    const ignored = paths.filter(isIgnoredReviewDiffPath)
    const shouldIgnore = ignored.length > 0 || (isBinaryDiffBlock(block) && paths.length > 0)
    const ignoredPaths = ignored.length > 0 ? ignored : paths

    if (!shouldIgnore) {
      return true
    }

    for (const file of ignoredPaths) {
      ignoredFiles.add(file)
    }

    return false
  })

  const text = kept.map(block => block.join("\n")).join("\n")
  return {
    text: /\r?\n$/u.test(diffText) && text ? `${text}\n` : text,
    ignoredFiles: Array.from(ignoredFiles).sort()
  }
}

/**
 * Parses the subset of unified diff syntax needed for GitHub review anchors:
 * changed LEFT/RIGHT lines plus surrounding hunk context lines.
 */
export function parseUnifiedDiff(diffText: string): ParsedDiff {
  const files = new Map<
    string,
    {
      path: string
      addedLines: Set<number>
      deletedLines: Set<number>
      rightLines: Set<number>
      leftLines: Set<number>
    }
  >()
  let currentPath: string | null = null
  let oldPath: string | null = null
  let newPath: string | null = null
  let inHunk = false
  let oldLine = 0
  let newLine = 0

  function fileInfo(filePath: string) {
    const existing = files.get(filePath)
    if (existing) {
      return existing
    }

    const created = {
      path: filePath,
      addedLines: new Set<number>(),
      deletedLines: new Set<number>(),
      rightLines: new Set<number>(),
      leftLines: new Set<number>()
    }
    files.set(filePath, created)
    return created
  }

  for (const line of diffText.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      currentPath = null
      oldPath = null
      newPath = null
      inHunk = false
      continue
    }

    if (line.startsWith("--- ")) {
      oldPath = normalizeDiffPath(line.slice(4).trim())
      currentPath = newPath || oldPath
      inHunk = false
      continue
    }

    if (line.startsWith("+++ ")) {
      newPath = normalizeDiffPath(line.slice(4).trim())
      currentPath = newPath || oldPath
      inHunk = false
      continue
    }

    if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/u.exec(line)
      inHunk = Boolean(match)
      // Line counters track the source line numbers GitHub expects, not the
      // line numbers inside the diff artifact.
      oldLine = match ? Number(match[1]) - 1 : 0
      newLine = match ? Number(match[3]) - 1 : 0
      continue
    }

    if (!inHunk || !currentPath) {
      continue
    }

    if (line.startsWith("\\")) {
      continue
    }

    const marker = line[0]
    if (marker === " ") {
      oldLine += 1
      newLine += 1
      const info = fileInfo(currentPath)
      info.leftLines.add(oldLine)
      info.rightLines.add(newLine)
    } else if (marker === "-") {
      oldLine += 1
      const info = fileInfo(currentPath)
      info.leftLines.add(oldLine)
      info.deletedLines.add(oldLine)
    } else if (marker === "+") {
      newLine += 1
      const info = fileInfo(currentPath)
      info.rightLines.add(newLine)
      info.addedLines.add(newLine)
    }
  }

  return {
    files: Array.from(files.values()).map(info => ({
      path: info.path,
      addedLines: Array.from(info.addedLines).sort((a, b) => a - b),
      deletedLines: Array.from(info.deletedLines).sort((a, b) => a - b),
      rightLines: Array.from(info.rightLines).sort((a, b) => a - b),
      leftLines: Array.from(info.leftLines).sort((a, b) => a - b)
    }))
  }
}

/**
 * Produces the validation lookup used by review tools before they accept inline
 * comments and by the runner before it submits GitHub review payloads.
 */
export function validCommentRangesFromDiff(diffText: string): ValidCommentRanges {
  const parsed = parseUnifiedDiff(diffText)

  return Object.fromEntries(
    parsed.files.map(file => [
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
