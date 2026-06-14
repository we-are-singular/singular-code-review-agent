import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isMainModule } from "../dist/lib/cli-main.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("CLI main detection treats symlinked entrypoints as main modules", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-main-"));
  const target = path.join(repoRoot, "dist", "cli", "review-comments.js");
  const symlink = path.join(dir, "review_comments");

  fs.symlinkSync(target, symlink);

  assert.equal(isMainModule(pathToFileURL(target).href, [process.execPath, symlink]), true);
  assert.equal(isMainModule(pathToFileURL(target).href, [process.execPath, path.join(dir, "other")]), false);
});
