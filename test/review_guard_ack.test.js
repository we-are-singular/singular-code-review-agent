const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const reviewGuard = path.join(repoRoot, "bin", "review_guard.sh");
const reviewAck = path.join(repoRoot, "bin", "review_ack.sh");

function makeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function parseOutputFile(file) {
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

function makeMockbin(ghBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-preflight-"));
  const mockbin = path.join(dir, "mockbin");
  fs.mkdirSync(mockbin);
  makeExecutable(path.join(mockbin, "gh"), ghBody);
  return { dir, mockbin };
}

function runScript(script, env) {
  const result = spawnSync("bash", [script], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

  assert.equal(result.status, 0, result.stderr);
}

test("review guard allows same-repository pull requests", () => {
  const { dir, mockbin } = makeMockbin(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "api repos/owner/repo/pulls/42" ]]; then
  printf '{"head":{"repo":{"full_name":"owner/repo"}}}\\n'
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`);
  const outputFile = path.join(dir, "github-output");

  runScript(reviewGuard, {
    ...process.env,
    PATH: `${mockbin}:${process.env.PATH}`,
    GITHUB_OUTPUT: outputFile,
    GITHUB_REPOSITORY: "owner/repo",
    PR_NUMBER: "42"
  });

  assert.deepEqual(parseOutputFile(outputFile), {
    should_review: "true",
    reason: "allowed"
  });
});

test("review guard skips fork pull requests", () => {
  const { dir, mockbin } = makeMockbin(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "api repos/owner/repo/pulls/42" ]]; then
  printf '{"head":{"repo":{"full_name":"someone/fork"}}}\\n'
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`);
  const outputFile = path.join(dir, "github-output");

  runScript(reviewGuard, {
    ...process.env,
    PATH: `${mockbin}:${process.env.PATH}`,
    GITHUB_OUTPUT: outputFile,
    GITHUB_REPOSITORY: "owner/repo",
    PR_NUMBER: "42"
  });

  assert.deepEqual(parseOutputFile(outputFile), {
    should_review: "false",
    reason: "fork pull requests are not reviewed"
  });
});

test("review guard skips untrusted trigger comments", () => {
  const { dir, mockbin } = makeMockbin(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "api repos/owner/repo/pulls/42" ]]; then
  printf '{"head":{"repo":{"full_name":"owner/repo"}}}\\n'
  exit 0
fi
if [[ "$*" == "api repos/owner/repo/issues/comments/99" ]]; then
  printf '{"issue_url":"https://api.github.com/repos/owner/repo/issues/42","author_association":"CONTRIBUTOR","user":{"type":"User"},"body":"@singular-code-review please review"}\\n'
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`);
  const outputFile = path.join(dir, "github-output");

  runScript(reviewGuard, {
    ...process.env,
    PATH: `${mockbin}:${process.env.PATH}`,
    GITHUB_OUTPUT: outputFile,
    GITHUB_REPOSITORY: "owner/repo",
    PR_NUMBER: "42",
    TRIGGER_COMMENT_ID: "99"
  });

  assert.deepEqual(parseOutputFile(outputFile), {
    should_review: "false",
    reason: "trigger comment author is not trusted"
  });
});

test("review ack skips comments already acknowledged by the bot", () => {
  const { dir, mockbin } = makeMockbin(`#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"repos/owner/repo/issues/comments/99/reactions"* && "$*" == *"--jq"* ]]; then
  printf '123\\n'
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`);
  const outputFile = path.join(dir, "github-output");

  runScript(reviewAck, {
    ...process.env,
    PATH: `${mockbin}:${process.env.PATH}`,
    GITHUB_OUTPUT: outputFile,
    GITHUB_REPOSITORY: "owner/repo",
    COMMENT_ID: "99",
    BOT_LOGIN: "singular-code-review[bot]"
  });

  assert.deepEqual(parseOutputFile(outputFile), {
    should_review: "false"
  });
});
