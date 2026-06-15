import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Dockerfile builds and packages the TypeScript runner surface", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

  assert.match(dockerfile, /^ARG NODE_VERSION=26\.3\.0$/m);
  assert.match(dockerfile, /^ARG NPM_MIN_VERSION=11\.13\.0$/m);
  assert.match(dockerfile, /\bbuild-essential\b/);
  assert.match(dockerfile, /\bpython3\b/);
  assert.match(dockerfile, /\bripgrep\b/);
  assert.match(dockerfile, /\bsqlite3\b/);
  assert.match(dockerfile, /npm ci/);
  assert.match(dockerfile, /npm run build/);
  assert.match(dockerfile, /\/usr\/local\/lib\/singular-code-review/);
  assert.match(dockerfile, /review_runner/);
  assert.match(dockerfile, /review_extract/);
  assert.match(dockerfile, /ln -sf \/usr\/local\/lib\/singular-code-review\/dist\/cli\/review-runner\.js \/usr\/local\/bin\/review_runner/);
  assert.match(dockerfile, /ln -sf \/usr\/local\/lib\/singular-code-review\/dist\/cli\/review-extract\.js \/usr\/local\/bin\/review_extract/);
  assert.match(dockerfile, /COPY opencode\/agents\/ \/usr\/local\/share\/singular-code-review\/agents\//);
  assert.match(dockerfile, /COPY opencode\/skills\/ \/usr\/local\/share\/singular-code-review\/skills\//);
  assert.match(dockerfile, /provision\.sh/);
  assert.doesNotMatch(dockerfile, /COPY opencode\/AGENTS\.md/);
  assert.doesNotMatch(dockerfile, /COPY bin\/review_runner/);
  assert.doesNotMatch(dockerfile, /review_orchestrator/);
  assert.doesNotMatch(dockerfile, /opencode_step/);
  assert.doesNotMatch(dockerfile, /lib\/review-tools/);
});

test("OpenCode config defines reviewer and auditor agents with scoped permissions", () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, "opencode", "opencode.json"), "utf8"));

  assert.deepEqual(config.permission.edit, {
    "*": "deny",
    "/tmp/.singular-code-review/**": "allow",
  });
  assert.deepEqual(config.permission.external_directory, {
    "/tmp/.singular-code-review/**": "allow",
  });
  assert.equal(config.default_agent, "reviewer");
  assert.equal(config.agent.reviewer.prompt, "{file:./agents/reviewer.md}");
  assert.equal(config.agent.auditor.prompt, "{file:./agents/auditor.md}");
  assert.deepEqual(config.agent.reviewer.permission.external_directory, config.permission.external_directory);
  assert.deepEqual(config.agent.reviewer.permission.edit, config.permission.edit);
  assert.deepEqual(config.agent.auditor.permission.external_directory, config.permission.external_directory);
  assert.deepEqual(config.agent.auditor.permission.edit, config.permission.edit);
  assert.equal(config.agent.reviewer.permission.bash, "allow");
  assert.equal(config.agent.auditor.permission.bash, "deny");
  assert.equal(config.agent.auditor.permission.webfetch, "deny");
  assert.equal(fs.existsSync(path.join(repoRoot, "opencode", "agents", "reviewer.md")), true);
  assert.equal(fs.existsSync(path.join(repoRoot, "opencode", "agents", "auditor.md")), true);
});

test("example trigger workflow does not run reviews on every push", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, "examples", "singular-code-review.yml"), "utf8");

  assert.match(workflow, /pull_request:\s*\n\s*types: \[opened, ready_for_review\]/);
  assert.doesNotMatch(workflow, /\bsynchronize\b/);
  assert.doesNotMatch(workflow, /\breopened\b/);
  assert.match(workflow, /issue_comment:\s*\n\s*types: \[created\]/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /contains\(github\.event\.comment\.body, '@singular-code-review'\)/);
  assert.match(workflow, /github\.event\.comment\.user\.type != 'Bot'/);
  assert.match(workflow, /concurrency:\s*\n\s+group: singular-code-review-\$\{\{ github\.event\.issue\.number \|\| github\.event\.pull_request\.number \|\| github\.event\.inputs\.pr_number \}\}/);
  assert.doesNotMatch(workflow, /"CONTRIBUTOR"/);
});

test("reusable workflow runs guard, ack, provisioning, and the new runner", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "review.yml"), "utf8");

  assert.match(workflow, /run: \/usr\/local\/bin\/review_guard/);
  assert.match(workflow, /run: \/usr\/local\/bin\/review_ack/);
  assert.match(workflow, /\/usr\/local\/bin\/provision\.sh/);
  assert.match(workflow, /\/usr\/local\/bin\/review_runner/);
  assert.match(workflow, /Extract review outputs and telemetry/);
  assert.match(workflow, /\/usr\/local\/bin\/review_extract --github-summary/);
  assert.doesNotMatch(workflow, /review_guard\.sh/);
  assert.doesNotMatch(workflow, /review_ack\.sh/);
  assert.doesNotMatch(workflow, /review_orchestrator/);
  assert.doesNotMatch(workflow, /concurrency:/);
  assert.doesNotMatch(workflow, /singular-code-review-\$\{\{ inputs\.pr_number \}\}/);
});
