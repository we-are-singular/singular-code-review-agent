const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const dryRun = path.join(repoRoot, "bin", "review_dry_run");

function makeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

test("runs orchestrator in dry-run mode with a read-only gh wrapper", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-dry-run-"));
  const mockbin = path.join(dir, "mockbin");
  const workspace = path.join(dir, "workspace");
  const envFile = path.join(dir, "orchestrator-env.json");
  fs.mkdirSync(mockbin);

  makeExecutable(
    path.join(mockbin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "auth" && "\${2:-}" == "status" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "repo" && "\${2:-}" == "clone" ]]; then
  mkdir -p "$4/.git"
  exit 0
fi
printf 'mock gh should not receive: %s\\n' "$*" >&2
exit 1
`
  );

  makeExecutable(
    path.join(mockbin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
exit 0
`
  );

  const orchestrator = path.join(dir, "orchestrator");
  makeExecutable(
    orchestrator,
    `#!/usr/bin/env bash
set -euo pipefail
node -e '
const fs = require("node:fs");
fs.writeFileSync(process.env.ENV_FILE, JSON.stringify({
  dryRun: process.env.DRY_RUN,
  repo: process.env.GITHUB_REPOSITORY,
  pr: process.env.PR_NUMBER,
  workspace: process.env.WORKSPACE,
  realGh: process.env.SINGULAR_CODE_REVIEW_REAL_GH,
  pathHead: process.env.PATH.split(":")[0]
}, null, 2));
'
if gh api -X POST repos/owner/repo/issues/1/comments -f body=test >/tmp/review-dry-run-gh.out 2>/tmp/review-dry-run-gh.err; then
  exit 2
fi
`
  );

  execFileSync("bash", [dryRun, "owner/repo", "42", "--workspace", workspace], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${mockbin}:${process.env.PATH}`,
      REVIEW_ORCHESTRATOR: orchestrator,
      ENV_FILE: envFile,
      OPENCODE_API_KEY: "test-opencode-key"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const env = JSON.parse(fs.readFileSync(envFile, "utf8"));
  assert.equal(env.dryRun, "true");
  assert.equal(env.repo, "owner/repo");
  assert.equal(env.pr, "42");
  assert.equal(env.workspace, workspace);
  assert.equal(env.realGh, path.join(mockbin, "gh"));
  assert.equal(env.pathHead, path.join(workspace, ".git", "singular-code-review", "dry-run-bin"));
});
