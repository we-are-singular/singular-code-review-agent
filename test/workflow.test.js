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
  assert.match(workflow, /contains\(github\.event\.comment\.body, '@singular-code-review'\)/);
});

test("reusable review workflow keeps acknowledgment inside one job", () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "review.yml"),
    "utf8"
  );

  assert.match(workflow, /\njobs:\s*\n\s+review:/);
  assert.match(workflow, /\ndefaults:\s*\n\s+run:\s*\n\s+shell: bash/);
  assert.doesNotMatch(workflow, /\n\s+ack:/);
  assert.doesNotMatch(workflow, /\n\s+needs: ack/);
  assert.match(workflow, /id: review-request/);
  assert.match(workflow, /echo "should_review=false" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /if: steps\.review-request\.outputs\.should_review == 'true'/);
});
