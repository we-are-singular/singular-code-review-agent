import assert from "node:assert/strict"
import test from "node:test"

import { acknowledgeReviewRequest } from "../dist/cli/review-ack.js"
import { evaluateGuard } from "../dist/cli/review-guard.js"

test("guard allows trusted same-repository trigger comments", async () => {
  const result = await evaluateGuard({
    repository: "owner/repo",
    prNumber: 42,
    triggerCommentId: 99,
    github: {
      async getPullRequest() {
        return { number: 42, head: { repo: { full_name: "owner/repo" } } }
      },
      async getIssueComment() {
        return {
          id: 99,
          issue_url: "https://api.github.com/repos/owner/repo/issues/42",
          author_association: "MEMBER",
          user: { login: "alice", type: "User" },
          body: "@singular-code-review please review"
        }
      }
    }
  })

  assert.deepEqual(result, { shouldReview: true, reason: "allowed" })
})

test("guard deterministically skips trusted skip commands", async () => {
  const result = await evaluateGuard({
    repository: "owner/repo",
    prNumber: 42,
    triggerCommentId: 99,
    github: {
      async getPullRequest() {
        return { number: 42, head: { repo: { full_name: "owner/repo" } } }
      },
      async getIssueComment() {
        return {
          id: 99,
          issue_url: "https://api.github.com/repos/owner/repo/issues/42",
          author_association: "MEMBER",
          user: { login: "alice", type: "User" },
          body: "@singular-code-review skip"
        }
      }
    }
  })

  assert.deepEqual(result, { shouldReview: false, reason: "trigger comment requested skip" })
})

test("guard does not treat incidental skip wording as a skip command", async () => {
  const result = await evaluateGuard({
    repository: "owner/repo",
    prNumber: 42,
    triggerCommentId: 99,
    github: {
      async getPullRequest() {
        return { number: 42, head: { repo: { full_name: "owner/repo" } } }
      },
      async getIssueComment() {
        return {
          id: 99,
          issue_url: "https://api.github.com/repos/owner/repo/issues/42",
          author_association: "MEMBER",
          user: { login: "alice", type: "User" },
          body: "@singular-code-review why did you skip the last review?"
        }
      }
    }
  })

  assert.deepEqual(result, { shouldReview: true, reason: "allowed" })
})

test("guard denies forks and untrusted trigger comments", async () => {
  assert.deepEqual(
    await evaluateGuard({
      repository: "owner/repo",
      prNumber: 42,
      triggerCommentId: null,
      github: {
        async getPullRequest() {
          return { number: 42, head: { repo: { full_name: "someone/fork" } } }
        },
        async getIssueComment() {
          throw new Error("not used")
        }
      }
    }),
    { shouldReview: false, reason: "fork pull requests are not reviewed" }
  )

  assert.deepEqual(
    await evaluateGuard({
      repository: "owner/repo",
      prNumber: 42,
      triggerCommentId: 99,
      github: {
        async getPullRequest() {
          return { number: 42, head: { repo: { full_name: "owner/repo" } } }
        },
        async getIssueComment() {
          return {
            id: 99,
            issue_url: "https://api.github.com/repos/owner/repo/issues/42",
            author_association: "CONTRIBUTOR",
            user: { login: "alice", type: "User" },
            body: "@singular-code-review please review"
          }
        }
      }
    }),
    { shouldReview: false, reason: "trigger comment author is not trusted" }
  )
})

test("guard matches trigger comment issue URLs by exact PR number", async () => {
  const result = await evaluateGuard({
    repository: "owner/repo",
    prNumber: 4,
    triggerCommentId: 99,
    github: {
      async getPullRequest() {
        return { number: 4, head: { repo: { full_name: "owner/repo" } } }
      },
      async getIssueComment() {
        return {
          id: 99,
          issue_url: "https://api.github.com/repos/owner/repo/issues/42",
          author_association: "MEMBER",
          user: { login: "alice", type: "User" },
          body: "@singular-code-review please review"
        }
      }
    }
  })

  assert.deepEqual(result, {
    shouldReview: false,
    reason: "trigger comment does not belong to this pull request"
  })
})

test("ack is idempotent and non-fatal when reaction creation fails", async () => {
  assert.deepEqual(
    await acknowledgeReviewRequest({
      botLogin: "singular-code-review[bot]",
      commentId: 99,
      github: {
        async listIssueCommentReactions() {
          return [{ id: 1, content: "eyes", user: { login: "singular-code-review[bot]" } }]
        },
        async createIssueCommentReaction() {
          throw new Error("not used")
        }
      }
    }),
    {
      shouldReview: false,
      message: "trigger comment already acknowledged by singular-code-review[bot]; skipping review"
    }
  )

  const created = []
  assert.deepEqual(
    await acknowledgeReviewRequest({
      botLogin: "singular-code-review[bot]",
      commentId: 99,
      github: {
        async listIssueCommentReactions() {
          return []
        },
        async createIssueCommentReaction(commentId, content) {
          created.push({ commentId, content })
        }
      }
    }),
    {
      shouldReview: true,
      message: "trigger comment acknowledged by singular-code-review[bot]; continuing review"
    }
  )
  assert.deepEqual(created, [{ commentId: 99, content: "eyes" }])

  assert.deepEqual(
    await acknowledgeReviewRequest({
      botLogin: "singular-code-review[bot]",
      commentId: 99,
      github: {
        async listIssueCommentReactions() {
          return []
        },
        async createIssueCommentReaction() {
          throw new Error("Resource not accessible by integration")
        }
      }
    }),
    {
      shouldReview: true,
      message: "could not acknowledge trigger comment; continuing review: Resource not accessible by integration"
    }
  )
})
