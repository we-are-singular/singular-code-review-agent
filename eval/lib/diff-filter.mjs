const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
]);

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bmp",
  ".br",
  ".bz2",
  ".class",
  ".dmg",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".rar",
  ".svg",
  ".tar",
  ".tgz",
  ".tif",
  ".tiff",
  ".ttf",
  ".wasm",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xz",
  ".zip",
  ".zst",
]);

function pathBasename(path) {
  return String(path || "").split(/[\\/]/u).pop() || "";
}

function pathExtension(path) {
  const base = pathBasename(path).toLowerCase();
  const index = base.lastIndexOf(".");
  return index >= 0 ? base.slice(index) : "";
}

function shouldIgnorePath(path) {
  const base = pathBasename(path);
  return LOCKFILE_NAMES.has(base) || BINARY_EXTENSIONS.has(pathExtension(path));
}

function parseDiffPath(line) {
  const match = /^diff --git a\/(.+?) b\/(.+)$/u.exec(line);
  return match ? match[2] : null;
}

export function filterUnifiedDiff(text) {
  const lines = String(text || "").split(/\n/u);
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      blocks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0 && current.some((line) => line.startsWith("diff --git "))) {
    blocks.push(current);
  }

  const kept = [];
  const ignoredFiles = [];
  for (const block of blocks) {
    const header = block.find((line) => line.startsWith("diff --git "));
    const path = parseDiffPath(header || "");
    const binary = block.some((line) => line.startsWith("GIT binary patch") || line.startsWith("Binary files "));
    if (path && (binary || shouldIgnorePath(path))) {
      ignoredFiles.push(path);
      continue;
    }
    kept.push(block.join("\n"));
  }

  return {
    text: kept.join("\n"),
    ignoredFiles,
  };
}
