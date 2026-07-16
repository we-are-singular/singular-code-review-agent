import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { main as reviewCommentsMain } from "../dist/cli/review-comments.js"
import { applyReviewBanner, buildReviewPayload, enforceReviewBodyLimit } from "../dist/review/body.js"
import { buildReviewerContext, buildValidationContext, createEmptyReviewContext } from "../dist/review/context.js"
import { filterReviewDiff, parseUnifiedDiff, validCommentRangesFromDiff } from "../dist/review/diff.js"
import {
  addInlineComment,
  addReply,
  addSuggestion,
  clearQueue,
  loadQueue,
  setConclusion,
  validateQueue
} from "../dist/review/queue.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixture = path.join(repoRoot, "test", "fixtures", "sample.patch")

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-contracts-"))
  return path.join(dir, name)
}

function context(diffText, overrides = {}) {
  return {
    generated_at: new Date().toISOString(),
    run: {
      event_name: null,
      reason: "manual",
      actor: null,
      trigger_comment: null,
      command: "@singular-code-review",
      bot_login: "review-bot"
    },
    pr: {},
    diff: { file: fixture, files: [] },
    valid_comment_ranges: validCommentRangesFromDiff(diffText),
    issue_comments: [],
    review_comments: [],
    review_threads_available: false,
    review_threads: [],
    unresolved_review_threads: [],
    unresolved_bot_threads: [],
    reviews: [],
    previous_bot_findings: [],
    action_items: [],
    ...overrides
  }
}

test("review body limit keeps verbose synthesized conclusions compact", () => {
  const body = enforceReviewBodyLimit("x".repeat(6_500))

  assert.ok(body.length <= 6_000)
  assert.match(body, /\[Review body truncated\]$/u)
})

test("queue supports comments, suggestions, replies, and conclusion", () => {
  const queueFile = tempFile("queue.json")
  clearQueue(queueFile)

  addInlineComment(queueFile, { path: "src/app.js", line: 2, body: "Single-line finding." })
  addInlineComment(queueFile, { path: "src/new.js", start_line: 1, line: 2, body: "Multi-line finding." })
  addSuggestion(queueFile, {
    path: "src/new.js",
    start_line: 1,
    line: 2,
    message: "Use one export.",
    replacement: "export const value = 2;"
  })
  addReply(queueFile, { to: 123, body: "This still needs a fix." })
  setConclusion(queueFile, "Review conclusion: one blocking issue remains.")

  const queue = loadQueue(queueFile)
  assert.equal(queue.inlineComments.length, 3)
  assert.equal(queue.replies.length, 1)
  assert.equal(queue.conclusion, "Review conclusion: one blocking issue remains.")
  assert.match(queue.inlineComments[2].body, /```suggestion/)
})

test("queue separates markdown rules from preceding prose before GitHub rendering", () => {
  const queueFile = tempFile("queue.json")
  clearQueue(queueFile)

  addInlineComment(queueFile, {
    path: "src/app.js",
    line: 2,
    body: "Problem sentence.\n---\n**action:** Fix the contract."
  })
  addSuggestion(queueFile, {
    path: "src/new.js",
    start_line: 1,
    line: 2,
    message: "Use the literal block.",
    replacement: "---\nvalue"
  })

  const queue = loadQueue(queueFile)
  assert.equal(queue.inlineComments[0].body, "Problem sentence.\n\n---\n**action:** Fix the contract.")
  assert.match(queue.inlineComments[1].body, /```suggestion\n---\nvalue\n```/u)
})

test("validation is deterministic and keeps genuinely distinct same-line findings", () => {
  const queueFile = tempFile("queue.json")
  const diffText = fs.readFileSync(fixture, "utf8")
  clearQueue(queueFile)

  addInlineComment(queueFile, { path: "src/app.js", line: 2, body: "The timeout can become NaN." })
  addInlineComment(queueFile, { path: "src/app.js", line: 2, body: "The timeout can overflow the retry budget." })
  addInlineComment(queueFile, { path: "src/app.js", line: 2, body: "The timeout can become NaN." })
  addInlineComment(queueFile, { path: "src/app.js", line: 3, side: "LEFT", body: "Deleted return path is valid." })
  addInlineComment(queueFile, { path: "src/app.js", line: 1, side: "RIGHT", body: "Right-side context should drop." })
  addInlineComment(queueFile, { path: "src/app.js", line: 99, body: "Line outside the diff should drop." })
  addReply(queueFile, { to: 456, body: "Reply is valid." })
  addReply(queueFile, { to: 789, body: "Reply target is missing." })
  setConclusion(queueFile, "LGTM aside from the queued finding.")

  const validated = validateQueue(loadQueue(queueFile), {
    ...context(diffText),
    review_comments: [{ id: 456, body: "Original", user: { login: "review-bot" } }]
  })

  assert.equal(validated.inlineComments.length, 3)
  assert.equal(validated.replies.length, 1)
  assert.equal(validated.dropped.length, 4)
  assert.equal(validated.stats.has_conclusion, true)
  assert.deepEqual(
    validated.dropped.map(item => item.reason),
    [
      "duplicate queued comment",
      "line is not a changed RIGHT-side line",
      "line is not a changed RIGHT-side line",
      "reply target is not a review comment on this PR"
    ]
  )
})

test("diff ranges support right-side context and left-side deletions", () => {
  const diffText = fs.readFileSync(fixture, "utf8")
  const app = parseUnifiedDiff(diffText).files.find(file => file.path === "src/app.js")

  assert.deepEqual(app?.addedLines, [2, 4, 6])
  assert.deepEqual(app?.deletedLines, [3])
  assert.deepEqual(app?.rightLines, [1, 2, 3, 4, 5, 6])
  assert.deepEqual(app?.leftLines, [1, 2, 3, 4])
})

test("review diff filtering excludes noisy generated and binary hunks", () => {
  const diffText = `diff --git a/package-lock.json b/package-lock.json
index 111..222 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
 {
-  "lockfileVersion": 2
+  "lockfileVersion": 3
 }
diff --git a/packages/api/pnpm-lock.yaml b/packages/api/pnpm-lock.yaml
index 111..222 100644
--- a/packages/api/pnpm-lock.yaml
+++ b/packages/api/pnpm-lock.yaml
@@ -1,2 +1,2 @@
-lockfileVersion: "8.0"
+lockfileVersion: "9.0"
diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..1111111
Binary files /dev/null and b/assets/logo.png differ
diff --git a/vendor/archive.zip b/vendor/archive.zip
index 1111111..2222222 100644
GIT binary patch
literal 0
HcmV?d00001
diff --git a/data/model b/data/model
index 1111111..2222222 100644
GIT binary patch
literal 0
HcmV?d00001
diff --git a/src/app.js b/src/app.js
index 333..444 100644
--- a/src/app.js
+++ b/src/app.js
@@ -1,2 +1,2 @@
-old
+new
`

  const filtered = filterReviewDiff(diffText)

  assert.deepEqual(filtered.ignoredFiles, [
    "assets/logo.png",
    "data/model",
    "package-lock.json",
    "packages/api/pnpm-lock.yaml",
    "vendor/archive.zip"
  ])
  assert.doesNotMatch(filtered.text, /lockfileVersion/u)
  assert.doesNotMatch(filtered.text, /GIT binary patch|Binary files/u)
  assert.match(filtered.text, /src\/app\.js/u)
  assert.deepEqual(
    parseUnifiedDiff(filtered.text).files.map(file => file.path),
    ["src/app.js"]
  )
})

test("review_comments rejects invalid targets before mutating the queue", async () => {
  const queueFile = tempFile("queue.json")
  const contextFile = tempFile("context.json")
  const diffText = fs.readFileSync(fixture, "utf8")
  fs.writeFileSync(contextFile, `${JSON.stringify(buildValidationContext(context(diffText)), null, 2)}\n`)

  await assert.rejects(
    reviewCommentsMain(
      ["add", "--path", "src/app.js", "--line", "1", "--body", "Do not comment on unchanged context."],
      {
        ...process.env,
        REVIEW_VALIDATION_CONTEXT_FILE: contextFile,
        REVIEW_QUEUE_FILE: queueFile
      }
    ),
    /invalid inline comment target: line is not a changed RIGHT-side line/u
  )
  assert.equal(loadQueue(queueFile).inlineComments.length, 0)

  await reviewCommentsMain(
    ["add", "--path", "src/app.js", "--line", "3", "--side", "LEFT", "--body", "Deleted branch needs explanation."],
    {
      ...process.env,
      REVIEW_VALIDATION_CONTEXT_FILE: contextFile,
      REVIEW_QUEUE_FILE: queueFile
    }
  )

  assert.deepEqual(loadQueue(queueFile).inlineComments, [
    {
      kind: "comment",
      path: "src/app.js",
      line: 3,
      side: "LEFT",
      body: "Deleted branch needs explanation."
    }
  ])
})

test("validation drops exact previous bot findings using thread state or REST fallback", () => {
  const queueFile = tempFile("queue.json")
  const diffText = fs.readFileSync(fixture, "utf8")
  clearQueue(queueFile)
  addInlineComment(queueFile, { path: "src/app.js", line: 2, body: "Existing finding." })

  const threadValidated = validateQueue(loadQueue(queueFile), {
    ...context(diffText),
    review_threads_available: true,
    unresolved_bot_threads: [
      {
        id: "thread-1",
        is_resolved: false,
        is_outdated: false,
        path: "src/app.js",
        line: 2,
        start_line: null,
        side: "RIGHT",
        start_side: null,
        top_level_comment_id: 456,
        top_level_author: "review-bot",
        latest_author: "review-bot",
        latest_comment_id: 456,
        comments: [
          {
            id: 456,
            node_id: null,
            user: { login: "review-bot" },
            body: "Existing finding.",
            path: "src/app.js",
            line: 2,
            start_line: null,
            side: "RIGHT",
            start_side: null,
            created_at: null,
            html_url: null
          }
        ]
      }
    ]
  })

  assert.equal(threadValidated.inlineComments.length, 0)
  assert.equal(threadValidated.dropped[0].reason, "matching unresolved bot thread already exists")

  clearQueue(queueFile)
  addInlineComment(queueFile, { path: "src/app.js", line: 2, body: "Existing finding." })
  const restValidated = validateQueue(loadQueue(queueFile), {
    ...context(diffText),
    review_threads_available: false,
    review_comments: [
      {
        id: 456,
        path: "src/app.js",
        line: 2,
        side: "RIGHT",
        body: "Existing finding.",
        user: { login: "review-bot" }
      }
    ]
  })

  assert.equal(restValidated.inlineComments.length, 0)
  assert.equal(restValidated.dropped[0].reason, "matching previous bot comment already exists")
})

test("review body banner is mechanical and does not sanitize model prose", () => {
  const body = applyReviewBanner(
    "> reviewer · minimax-m3\n\nThe model wrote a banner anyway.",
    "opencode-go/minimax-m3"
  )

  assert.equal(body, "> reviewer · minimax-m3\n\n> reviewer · minimax-m3\n\nThe model wrote a banner anyway.")
})

test("review payload maps validated queue comments to GitHub review shape", () => {
  const payload = buildReviewPayload({
    version: 1,
    conclusion: "> reviewer · minimax-m3\n\nReady to merge.",
    dropped: [],
    replies: [],
    stats: {
      queued_inline: 1,
      queued_replies: 0,
      has_conclusion: true,
      valid_inline: 1,
      valid_replies: 0,
      dropped: 0
    },
    inlineComments: [
      {
        kind: "comment",
        path: "src/app.js",
        start_line: 2,
        line: 3,
        side: "LEFT",
        start_side: "LEFT",
        body: "Deleted branch needs explanation."
      }
    ]
  })

  assert.deepEqual(payload, {
    body: "> reviewer · minimax-m3\n\nReady to merge.",
    event: "COMMENT",
    comments: [
      {
        path: "src/app.js",
        start_line: 2,
        line: 3,
        side: "LEFT",
        start_side: "LEFT",
        body: "Deleted branch needs explanation."
      }
    ]
  })
})

test("participants exclude bot logins with or without the bot suffix", () => {
  const reviewerContext = buildReviewerContext({
    ...createEmptyReviewContext(),
    run: {
      event_name: null,
      reason: "manual",
      actor: null,
      trigger_comment: null,
      command: "@singular-code-review",
      bot_login: "singular-code-review[bot]"
    },
    issue_comments: [
      { id: 1, user: { login: "singular-code-review" }, body: "Bot-authored review note." },
      { id: 2, user: { login: "linear-code[bot]" }, body: "SHE-170" },
      { id: 3, user: { login: "fthemudo" }, body: "Thanks for the review." }
    ]
  })

  assert.deepEqual(reviewerContext.participants, ["<@fthemudo>"])
})
