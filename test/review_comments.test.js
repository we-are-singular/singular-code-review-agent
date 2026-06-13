const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  addInlineComment,
  addReply,
  addSuggestion,
  setConclusion,
  clearQueue,
  loadQueue,
  validateQueue,
  validCommentRangesFromDiff
} = require("../lib/review-tools");

const repoRoot = path.resolve(__dirname, "..");
const fixture = path.join(repoRoot, "test", "fixtures", "sample.patch");

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-comments-"));
  return path.join(dir, name);
}

test("queues inline comments, multiline comments, suggestions, and replies", () => {
  const queueFile = tempFile("queue.json");
  clearQueue(queueFile);

  addInlineComment({ path: "src/app.js", line: 2, body: "Single-line finding." }, queueFile);
  addInlineComment({ path: "src/new.js", start_line: 1, line: 2, body: "Multi-line finding." }, queueFile);
  addSuggestion(
    {
      path: "src/new.js",
      start_line: 1,
      line: 2,
      message: "Use one export.",
      replacement: "export const value = 2;"
    },
    queueFile
  );
  addReply({ to: 123, body: "This still needs a fix." }, queueFile);
  setConclusion({ body: "Review conclusion: one blocking issue remains." }, queueFile);

  const queue = loadQueue(queueFile);
  assert.equal(queue.inlineComments.length, 3);
  assert.equal(queue.replies.length, 1);
  assert.equal(queue.conclusion, "Review conclusion: one blocking issue remains.");
  assert.match(queue.inlineComments[2].body, /```suggestion/);
});

test("validates queued items against diff context and reply targets", () => {
  const queueFile = tempFile("queue.json");
  const diffText = fs.readFileSync(fixture, "utf8");
  clearQueue(queueFile);

  addInlineComment({ path: "src/app.js", line: 2, body: "Valid." }, queueFile);
  addInlineComment({ path: "src/app.js", line: 1, body: "Invalid context line." }, queueFile);
  addReply({ to: 456, body: "Reply is valid." }, queueFile);
  addReply({ to: 789, body: "Reply target is missing." }, queueFile);
  setConclusion({ body: "LGTM aside from the queued finding." }, queueFile);

  const validated = validateQueue(loadQueue(queueFile), {
    valid_comment_ranges: validCommentRangesFromDiff(diffText),
    review_comments: [{ id: 456, body: "Original", user: { login: "bot" } }]
  });

  assert.equal(validated.inlineComments.length, 1);
  assert.equal(validated.replies.length, 1);
  assert.equal(validated.dropped.length, 2);
  assert.equal(validated.conclusion, "LGTM aside from the queued finding.");
  assert.equal(validated.stats.has_conclusion, true);
});
