const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const script = path.join(repoRoot, "bin", "filter_review_comments");
const fixture = path.join(repoRoot, "test", "fixtures", "sample.patch");
const { filterReviewComments } = require(script);

test("keeps only staged comments on RIGHT-side added lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filter-review-"));
  const stagedFile = path.join(dir, "staged.json");
  const outputFile = path.join(dir, "filtered.json");

  fs.writeFileSync(
    stagedFile,
    JSON.stringify([
      { path: "src/app.js", line: 2, side: "RIGHT", body: "Valid added line." },
      { path: "src/app.js", line: 1, side: "RIGHT", body: "Context line should drop." },
      { path: "src/new.js", line: 2, side: "RIGHT", body: "Valid new file line." },
      { path: "src/new.js", line: 2, side: "LEFT", body: "Wrong side should drop." },
      { path: "src/app.js", line: 2, side: "RIGHT", body: "Valid added line." }
    ])
  );

  const stats = filterReviewComments(fixture, stagedFile, outputFile);
  const filtered = JSON.parse(fs.readFileSync(outputFile, "utf8"));

  assert.deepEqual(stats, { staged: 5, valid: 2, dropped: 3 });
  assert.deepEqual(filtered, [
    { path: "src/app.js", line: 2, side: "RIGHT", body: "Valid added line." },
    { path: "src/new.js", line: 2, side: "RIGHT", body: "Valid new file line." }
  ]);
});
