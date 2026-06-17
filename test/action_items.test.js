import assert from "node:assert/strict"
import test from "node:test"

import { buildActionItems } from "../dist/review/context.js"

const botLogin = "singular-code-review[bot]"
const command = "@singular-code-review"

function trigger(overrides = {}) {
  return {
    event_name: "pull_request",
    reason: "synchronize",
    actor: "octocat",
    trigger_comment: null,
    ...overrides
  }
}

function issueComment(id, body, createdAt, login = "octocat") {
  return {
    id,
    body,
    created_at: createdAt,
    html_url: `https://github.com/owner/repo/pull/42#issuecomment-${id}`,
    author_association: "MEMBER",
    user: { login }
  }
}

function botReview(submittedAt) {
  return {
    id: 1,
    user: { login: botLogin },
    state: "COMMENTED",
    body: "Reviewed.",
    submitted_at: submittedAt,
    commit_id: "abc123",
    html_url: "https://github.com/owner/repo/pull/42#pullrequestreview-1"
  }
}

function actionItems(overrides = {}) {
  return buildActionItems({
    trigger: trigger(),
    issueComments: [],
    reviewComments: [],
    reviewThreads: [],
    reviewThreadsAvailable: true,
    reviews: [],
    botLogin,
    command,
    ...overrides
  })
}

test("push-triggered runs ignore mention comments already followed by a bot review", () => {
  const items = actionItems({
    issueComments: [issueComment(10, "@singular-code-review can you try again?", "2026-06-17T00:25:00Z")],
    reviews: [botReview("2026-06-17T00:31:00Z")]
  })

  assert.deepEqual(items, [])
})

test("push-triggered runs keep mention comments newer than the latest bot activity", () => {
  const items = actionItems({
    issueComments: [issueComment(10, "@singular-code-review can you try again?", "2026-06-17T00:35:00Z")],
    reviews: [botReview("2026-06-17T00:31:00Z")]
  })

  assert.deepEqual(items, [
    {
      id: "issue-comment:10",
      kind: "mentioned",
      actor: "octocat",
      body: "@singular-code-review can you try again?",
      comment_id: 10,
      created_at: "2026-06-17T00:35:00Z"
    }
  ])
})

test("bot issue-comment answers also make older mention comments stale", () => {
  const items = actionItems({
    issueComments: [
      issueComment(10, "@singular-code-review does this still apply?", "2026-06-17T00:25:00Z"),
      issueComment(11, "Yes, that finding still applies.", "2026-06-17T00:26:00Z", botLogin)
    ]
  })

  assert.deepEqual(items, [])
})

test("direct trigger comments are represented once as trigger requests", () => {
  const comment = issueComment(10, "@singular-code-review can you try again?", "2026-06-17T00:35:00Z")
  const items = actionItems({
    trigger: trigger({
      event_name: "issue_comment",
      reason: "mention",
      trigger_comment: {
        id: 10,
        user: "octocat",
        body: comment.body,
        html_url: comment.html_url
      }
    }),
    issueComments: [comment]
  })

  assert.deepEqual(items, [
    {
      id: "issue-comment:10",
      kind: "trigger_request",
      actor: "octocat",
      body: "@singular-code-review can you try again?",
      comment_id: 10
    }
  ])
})
