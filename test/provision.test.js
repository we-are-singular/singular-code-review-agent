import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provision = path.join(repoRoot, "bin", "provision.sh");

function makeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function runProvision(workspace, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provision-"));
  const home = path.join(dir, "home");
  const xdgConfigHome = path.join(dir, "xdg-config");
  const effectiveXdgConfigHome = extraEnv.XDG_CONFIG_HOME || xdgConfigHome;
  const mockbin = path.join(dir, "mockbin");
  const npmArgsFile = path.join(dir, "npm-args.json");
  fs.mkdirSync(mockbin);

  makeExecutable(
    path.join(mockbin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ ! -d "\${HOME:?}" ]]; then
  printf 'HOME does not exist: %s\\n' "$HOME" >&2
  exit 12
fi
exit 0
`,
  );

  makeExecutable(
    path.join(mockbin, "npm"),
    `#!/usr/bin/env bash
set -euo pipefail
node -e '
const fs = require("node:fs");
fs.writeFileSync(process.env.NPM_ARGS_FILE, JSON.stringify(process.argv.slice(1)));
' "$@"
`,
  );

  execFileSync("bash", [provision], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: xdgConfigHome,
      PATH: `${mockbin}:${process.env.PATH}`,
      WORKSPACE: workspace,
      NPM_ARGS_FILE: npmArgsFile,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    home,
    xdgConfigHome: effectiveXdgConfigHome,
    npmArgs: fs.existsSync(npmArgsFile) ? JSON.parse(fs.readFileSync(npmArgsFile, "utf8")) : null,
  };
}

test("provision runs npm ci with install scripts allowed", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "provision-workspace-"));
  fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
  fs.writeFileSync(path.join(workspace, "package-lock.json"), "{}\n");

  assert.deepEqual(runProvision(workspace).npmArgs, ["ci", "--dangerously-allow-all-scripts"]);
});

test("provision runs npm install with install scripts allowed", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "provision-workspace-"));
  fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");

  assert.deepEqual(runProvision(workspace).npmArgs, ["install", "--no-package-lock", "--dangerously-allow-all-scripts"]);
});

test("provision installs OpenCode config and skills into XDG config home", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "provision-workspace-"));
  const xdgConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), "provision-xdg-config-"));
  const result = runProvision(workspace, { XDG_CONFIG_HOME: xdgConfigHome });

  assert.equal(fs.existsSync(path.join(result.home, ".config", "opencode", "opencode.json")), false);
  assert.equal(fs.existsSync(path.join(result.xdgConfigHome, "opencode", "opencode.json")), true);
  assert.equal(fs.existsSync(path.join(result.xdgConfigHome, "opencode", "agents", "reviewer.md")), true);
  assert.equal(fs.existsSync(path.join(result.xdgConfigHome, "opencode", "agents", "auditor.md")), true);
  assert.equal(
    fs.existsSync(path.join(result.xdgConfigHome, "opencode", "skills", "singular-code-review", "SKILL.md")),
    true,
  );
});
