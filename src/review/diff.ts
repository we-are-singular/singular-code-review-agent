import {
  type ParsedDiff,
  type ValidCommentRanges,
} from "./types.js";

/**
 * Normalizes unified-diff paths into repository-relative paths. `/dev/null`
 * marks file creation/deletion metadata rather than a commentable file path.
 */
export function normalizeDiffPath(rawPath: string): string | null {
  if (!rawPath || rawPath === "/dev/null") {
    return null;
  }

  if (rawPath.startsWith("a/") || rawPath.startsWith("b/")) {
    return rawPath.slice(2);
  }

  return rawPath;
}

/**
 * Parses the subset of unified diff syntax needed for GitHub review anchors:
 * changed LEFT/RIGHT lines plus surrounding hunk context lines.
 */
export function parseUnifiedDiff(diffText: string): ParsedDiff {
  const files = new Map<
    string,
    {
      path: string;
      addedLines: Set<number>;
      deletedLines: Set<number>;
      rightLines: Set<number>;
      leftLines: Set<number>;
    }
  >();
  let currentPath: string | null = null;
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  function fileInfo(filePath: string) {
    const existing = files.get(filePath);
    if (existing) {
      return existing;
    }

    const created = {
      path: filePath,
      addedLines: new Set<number>(),
      deletedLines: new Set<number>(),
      rightLines: new Set<number>(),
      leftLines: new Set<number>(),
    };
    files.set(filePath, created);
    return created;
  }

  for (const line of diffText.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      currentPath = null;
      oldPath = null;
      newPath = null;
      inHunk = false;
      continue;
    }

    if (line.startsWith("--- ")) {
      oldPath = normalizeDiffPath(line.slice(4).trim());
      currentPath = newPath || oldPath;
      inHunk = false;
      continue;
    }

    if (line.startsWith("+++ ")) {
      newPath = normalizeDiffPath(line.slice(4).trim());
      currentPath = newPath || oldPath;
      inHunk = false;
      continue;
    }

    if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/u.exec(line);
      inHunk = Boolean(match);
      // Line counters track the source line numbers GitHub expects, not the
      // line numbers inside the diff artifact.
      oldLine = match ? Number(match[1]) - 1 : 0;
      newLine = match ? Number(match[3]) - 1 : 0;
      continue;
    }

    if (!inHunk || !currentPath) {
      continue;
    }

    if (line.startsWith("\\")) {
      continue;
    }

    const marker = line[0];
    if (marker === " ") {
      oldLine += 1;
      newLine += 1;
      const info = fileInfo(currentPath);
      info.leftLines.add(oldLine);
      info.rightLines.add(newLine);
    } else if (marker === "-") {
      oldLine += 1;
      const info = fileInfo(currentPath);
      info.leftLines.add(oldLine);
      info.deletedLines.add(oldLine);
    } else if (marker === "+") {
      newLine += 1;
      const info = fileInfo(currentPath);
      info.rightLines.add(newLine);
      info.addedLines.add(newLine);
    }
  }

  return {
    files: Array.from(files.values()).map((info) => ({
      path: info.path,
      addedLines: Array.from(info.addedLines).sort((a, b) => a - b),
      deletedLines: Array.from(info.deletedLines).sort((a, b) => a - b),
      rightLines: Array.from(info.rightLines).sort((a, b) => a - b),
      leftLines: Array.from(info.leftLines).sort((a, b) => a - b),
    })),
  };
}

/**
 * Produces the validation lookup used by review tools before they accept inline
 * comments and by the runner before it submits GitHub review payloads.
 */
export function validCommentRangesFromDiff(diffText: string): ValidCommentRanges {
  const parsed = parseUnifiedDiff(diffText);

  return Object.fromEntries(
    parsed.files.map((file) => [
      file.path,
      {
        added_lines: file.addedLines,
        deleted_lines: file.deletedLines,
        right_lines: file.rightLines,
        left_lines: file.leftLines,
      },
    ]),
  );
}
