const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

test("example trigger workflow does not run reviews on every push", () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, "examples", "singular-code-review.yml"),
    "utf8"
  );

  assert.match(workflow, /pull_request:\s*\n\s*types: \[opened, ready_for_review\]/);
  assert.doesNotMatch(workflow, /\bsynchronize\b/);
  assert.doesNotMatch(workflow, /\breopened\b/);
  assert.match(workflow, /issue_comment:\s*\n\s*types: \[created\]/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /contains\(github\.event\.comment\.body, '@singular-code-review'\)/);
  assert.match(
    workflow,
    /contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.comment\.author_association\)/
  );
  assert.match(workflow, /github\.event\.comment\.user\.type != 'Bot'/);
  assert.doesNotMatch(workflow, /"CONTRIBUTOR"/);
  assert.match(
    workflow,
    /concurrency:\s*\n\s+group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.issue\.number \|\| github\.event\.pull_request\.number \|\| github\.event\.inputs\.pr_number \|\| github\.run_id \}\}\s*\n\s+cancel-in-progress: true/
  );
});

test("reusable review workflow guards unsafe requests before running the agent", () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "review.yml"),
    "utf8"
  );

  assert.match(workflow, /\njobs:\s*\n\s+agent:/);
  assert.match(workflow, /id: review-guard/);
  assert.match(workflow, /run: \/usr\/local\/bin\/review_guard\.sh/);
  assert.match(workflow, /if: steps\.review-guard\.outputs\.should_review == 'true'/);
  assert.match(workflow, /run: \/usr\/local\/bin\/review_ack\.sh/);
  assert.match(workflow, /\ndefaults:\s*\n\s+run:\s*\n\s+shell: bash/);
  assert.doesNotMatch(workflow, /\n\s+ack:/);
  assert.doesNotMatch(workflow, /\n\s+needs: ack/);
  assert.match(workflow, /id: review-request/);
  assert.match(workflow, /if: steps\.review-request\.outputs\.should_review == 'true'/);
});
