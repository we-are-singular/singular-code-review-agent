import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getErrorMessage } from "./errors.js";

function realPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * Detects direct CLI execution, including symlinked bin entries installed into
 * the container PATH.
 */
export function isMainModule(metaUrl: string, argv = process.argv): boolean {
  const entrypoint = argv[1];
  if (!entrypoint) {
    return false;
  }

  return realPath(fileURLToPath(metaUrl)) === realPath(entrypoint);
}

/**
 * Standardizes CLI error reporting while keeping each command importable from
 * tests without executing immediately.
 */
export function runCliMain(metaUrl: string, name: string, main: () => Promise<void>): void {
  if (!isMainModule(metaUrl)) {
    return;
  }

  main().catch((error) => {
    process.stderr.write(`${name}: ${getErrorMessage(error)}\n`);
    process.exit(1);
  });
}
