import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDryRunGitHubClient } from "../dist/clients/github.js";
import { buildArtifactPaths } from "../dist/config/paths.js";
import { ArtifactStore } from "../dist/lib/artifacts.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = path.join(repoRoot, "bin", "review_dry_run");

function makeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

test("dry-run GitHub client writes payload and replies to artifacts instead of delegate writes", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dry-client-"));
  fs.mkdirSync(path.join(workspace, ".git"));
  const artifacts = new ArtifactStore(buildArtifactPaths({}, workspace));
  const delegateWrites = [];
  const delegate = {
    async getPullRequest() {
      return { number: 42 };
    },
    async getPullRequestDiff() {
      return "";
    },
    async getIssueComment() {
      return { id: 1 };
    },
    async listIssueComments() {
      return [];
    },
    async listReviewComments() {
      return [];
    },
    async listReviews() {
      return [];
    },
    async listReviewThreads() {
      return { available: true, threads: [] };
    },
    async listIssueCommentReactions() {
      return [];
    },
    async createIssueCommentReaction() {
      delegateWrites.push("reaction");
    },
    async submitReview() {
      delegateWrites.push("review");
    },
    async submitReply() {
      delegateWrites.push("reply");
    },
  };

  const client = createDryRunGitHubClient(delegate, artifacts);
  await client.submitReview(42, { body: "Dry run body", event: "COMMENT", comments: [] });
  await client.submitReply(42, 123, "Dry run reply");
  await client.createIssueCommentReaction(99, "eyes");

  assert.deepEqual(delegateWrites, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(artifacts.paths.payloadFile, "utf8")), {
    body: "Dry run body",
    event: "COMMENT",
    comments: [],
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(artifacts.child("dry-run-reply-123.json"), "utf8")), {
    body: "Dry run reply",
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(artifacts.child("dry-run-reaction-99.json"), "utf8")), {
    content: "eyes",
  });
});

test("review_dry_run runs provision and runner with read-only gh wrapper", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-dry-run-"));
  const mockbin = path.join(dir, "mockbin");
  const workspace = path.join(dir, "workspace");
  const provisionEnvFile = path.join(dir, "provision-env.json");
  const runnerEnvFile = path.join(dir, "runner-env.json");
  fs.mkdirSync(mockbin);

  makeExecutable(
    path.join(mockbin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "auth" && "\${2:-}" == "status" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "auth" && "\${2:-}" == "token" ]]; then
  printf 'mock-token\\n'
  exit 0
fi
if [[ "\${1:-}" == "repo" && "\${2:-}" == "clone" ]]; then
  mkdir -p "$4/.git"
  exit 0
fi
printf 'mock gh should not receive: %s\\n' "$*" >&2
exit 1
`,
  );

  makeExecutable(
    path.join(mockbin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
exit 0
`,
  );

  const provision = path.join(dir, "provision");
  makeExecutable(
    provision,
    `#!/usr/bin/env bash
set -euo pipefail
node -e '
const fs = require("node:fs");
fs.writeFileSync(process.env.PROVISION_ENV_FILE, JSON.stringify({
  dryRun: process.env.DRY_RUN,
  token: process.env.GH_TOKEN,
  workspace: process.env.WORKSPACE,
  home: process.env.HOME,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  pathHead: process.env.PATH.split(":")[0]
}, null, 2));
'
`,
  );

  const runner = path.join(dir, "runner");
  makeExecutable(
    runner,
    `#!/usr/bin/env bash
set -euo pipefail
node -e '
const fs = require("node:fs");
fs.writeFileSync(process.env.RUNNER_ENV_FILE, JSON.stringify({
  dryRun: process.env.DRY_RUN,
  token: process.env.GH_TOKEN,
  repo: process.env.GITHUB_REPOSITORY,
  pr: process.env.PR_NUMBER,
  workspace: process.env.WORKSPACE,
  home: process.env.HOME,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  realGh: process.env.SINGULAR_CODE_REVIEW_REAL_GH,
  pathHead: process.env.PATH.split(":")[0]
}, null, 2));
'
if gh api -X POST repos/owner/repo/issues/1/comments -f body=test >/tmp/review-dry-run-gh.out 2>/tmp/review-dry-run-gh.err; then
  exit 2
fi
`,
  );

  execFileSync("bash", [dryRun, "owner/repo", "42", "--workspace", workspace], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${mockbin}:${process.env.PATH}`,
      REVIEW_PROVISION: provision,
      REVIEW_RUNNER: runner,
      PROVISION_ENV_FILE: provisionEnvFile,
      RUNNER_ENV_FILE: runnerEnvFile,
      OPENCODE_API_KEY: "test-opencode-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const provisionEnv = JSON.parse(fs.readFileSync(provisionEnvFile, "utf8"));
  const runnerEnv = JSON.parse(fs.readFileSync(runnerEnvFile, "utf8"));
  assert.match(provisionEnv.pathHead, /^\/tmp\/\.singular-code-review\/owner-repo-pr-42-/u);
  const wrapperDir = provisionEnv.pathHead;
  const runtimeDir = path.dirname(wrapperDir);

  assert.deepEqual(provisionEnv, {
    dryRun: "true",
    token: "mock-token",
    workspace,
    home: path.join(runtimeDir, "home"),
    xdgConfigHome: path.join(runtimeDir, "xdg", "config"),
    pathHead: wrapperDir,
  });
  assert.equal(runnerEnv.dryRun, "true");
  assert.equal(runnerEnv.token, "mock-token");
  assert.equal(runnerEnv.repo, "owner/repo");
  assert.equal(runnerEnv.pr, "42");
  assert.equal(runnerEnv.workspace, workspace);
  assert.equal(runnerEnv.home, path.join(runtimeDir, "home"));
  assert.equal(runnerEnv.xdgConfigHome, path.join(runtimeDir, "xdg", "config"));
  assert.equal(runnerEnv.realGh, path.join(mockbin, "gh"));
  assert.equal(runnerEnv.pathHead, wrapperDir);
});

test("review_dry_run keeps explicit runtime dir artifacts and reports provision failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-dry-run-"));
  const mockbin = path.join(dir, "mockbin");
  const workspace = path.join(dir, "workspace");
  const runtimeDir = path.join(dir, "runtime");
  const runnerMarker = path.join(dir, "runner-ran");
  fs.mkdirSync(mockbin);

  makeExecutable(
    path.join(mockbin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "auth" && "\${2:-}" == "status" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "auth" && "\${2:-}" == "token" ]]; then
  printf 'mock-token\\n'
  exit 0
fi
if [[ "\${1:-}" == "repo" && "\${2:-}" == "clone" ]]; then
  mkdir -p "$4/.git"
  exit 0
fi
exit 1
`,
  );

  makeExecutable(
    path.join(mockbin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
exit 0
`,
  );

  const provision = path.join(dir, "provision");
  makeExecutable(
    provision,
    `#!/usr/bin/env bash
set -euo pipefail
exit 7
`,
  );

  const runner = path.join(dir, "runner");
  makeExecutable(
    runner,
    `#!/usr/bin/env bash
set -euo pipefail
touch "${runnerMarker}"
`,
  );

  const result = spawnSync("bash", [dryRun, "owner/repo", "42", "--workspace", workspace, "--runtime-dir", runtimeDir], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${mockbin}:${process.env.PATH}`,
      REVIEW_PROVISION: provision,
      REVIEW_RUNNER: runner,
      OPENCODE_API_KEY: "test-opencode-key",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 7);
  assert.match(result.stderr, new RegExp(`dry-run runtime dir: ${runtimeDir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`));
  assert.match(result.stderr, /provision step failed with status 7; review runner was not started/u);
  assert.match(result.stderr, /review payload: .+review_payload\.json \(missing\)/u);
  assert.equal(fs.existsSync(path.join(runtimeDir, "dry-run-bin", "gh")), true);
  assert.equal(fs.existsSync(runnerMarker), false);
});
