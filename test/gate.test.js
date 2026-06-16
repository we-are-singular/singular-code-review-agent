import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createEmptyReviewContext } from "../dist/review/context.js"
import { parseGateDecision, prepareGate } from "../dist/review/gate.js"

const botLogin = "singular-code-review[bot]"

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
}

function write(repo, file, body) {
  const target = path.join(repo, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body)
}

function commit(repo, message) {
  git(repo, ["add", "."])
  git(repo, ["commit", "-m", message])
  return git(repo, ["rev-parse", "HEAD"])
}

function createRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "gate-repo-"))
  git(repo, ["init"])
  git(repo, ["config", "user.email", "reviewer@example.com"])
  git(repo, ["config", "user.name", "Reviewer"])
  const defaultBranch = git(repo, ["branch", "--show-current"])
  write(repo, "README.md", "base\n")
  const base = commit(repo, "base")
  git(repo, ["checkout", "-b", "feature"])
  write(repo, "src/app.js", "export const value = 1;\n")
  const reviewed = commit(repo, "feature reviewed")
  return { repo, base, reviewed, defaultBranch }
}

function reviewContext(options) {
  const triggerComment =
    options.reason === "mention"
      ? {
          id: 123,
          user: "octocat",
          body: options.commentBody || "@singular-code-review should this run again?",
          html_url: null
        }
      : null

  return createEmptyReviewContext({
    run: {
      event_name: options.reason === "mention" ? "issue_comment" : "pull_request",
      reason: options.reason,
      actor: "octocat",
      trigger_comment: triggerComment,
      command: "@singular-code-review",
      bot_login: botLogin
    },
    pr: {
      number: 42,
      title: "Test PR",
      base: { sha: options.base },
      head: { sha: options.head, repo: { full_name: "owner/repo" } },
      baseRefOid: options.base,
      headRefOid: options.head
    },
    diff: {
      file: "pr.diff",
      files: ["src/app.js"],
      ignored_files: []
    },
    reviews: options.reviews || [],
    issue_comments: triggerComment
      ? [
          {
            id: 123,
            user: { login: "octocat" },
            body: triggerComment.body,
            html_url: null,
            author_association: "MEMBER"
          }
        ]
      : []
  })
}

function botReview(commitId) {
  return {
    id: 1,
    user: { login: botLogin },
    state: "COMMENTED",
    body: "Previous review.",
    submitted_at: "2026-06-15T00:00:00Z",
    commit_id: commitId,
    html_url: "https://github.com/owner/repo/pull/42#pullrequestreview-1"
  }
}

test("gate decision parser accepts only the exact review shape", () => {
  assert.deepEqual(parseGateDecision('{"decision":"review","reason":"meaningful code delta"}'), {
    decision: "review",
    reason: "meaningful code delta"
  })

  assert.throws(() => parseGateDecision('{"decision":"review","reason":"x","answer":"extra"}'), /decision and reason/u)
  assert.throws(() => parseGateDecision('```json\n{"decision":"review","reason":"x"}\n```'), /Unexpected token/u)
})

test("gate decision parser accepts only answer-bearing no-review and answer shapes", () => {
  assert.deepEqual(parseGateDecision('{"decision":"no-review","answer":"Docs only."}'), {
    decision: "no-review",
    answer: "Docs only."
  })
  assert.deepEqual(parseGateDecision('{"decision":"answer","answer":"Yes."}'), {
    decision: "answer",
    answer: "Yes."
  })

  assert.throws(() => parseGateDecision('{"decision":"no-review","reason":"docs"}'), /decision and answer/u)
  assert.throws(
    () => parseGateDecision('{"decision":"answer","answer":"Yes.","reason":"extra"}'),
    /decision and answer/u
  )
})

test("synchronize without a previous bot review runs the full review without gate", () => {
  const { repo, base, reviewed } = createRepo()
  const context = reviewContext({ reason: "synchronize", base, head: reviewed, reviews: [] })
  const result = prepareGate({ context, workspace: repo, diffText: "diff", botLogin })

  assert.deepEqual(result, { action: "run-review", reason: "no previous bot review" })
})

test("synchronize on the already reviewed head posts no-review without OpenCode", () => {
  const { repo, base, reviewed } = createRepo()
  const context = reviewContext({
    reason: "synchronize",
    base,
    head: reviewed,
    reviews: [botReview(reviewed)]
  })
  const result = prepareGate({ context, workspace: repo, diffText: "diff", botLogin })

  assert.equal(result.action, "post")
  assert.equal(result.decision.decision, "no-review")
  assert.equal(result.context.delta.mode, "same_head")
})

test("synchronize after an ancestor commit sends the commit delta to the gate", () => {
  const { repo, base, reviewed } = createRepo()
  write(repo, "src/app.js", "export const value = 2;\n")
  const head = commit(repo, "feature update")
  const context = reviewContext({
    reason: "synchronize",
    base,
    head,
    reviews: [botReview(reviewed)]
  })
  const result = prepareGate({ context, workspace: repo, diffText: git(repo, ["diff", `${base}..${head}`]), botLogin })

  assert.equal(result.action, "run-gate")
  assert.equal(result.context.delta.mode, "ancestor_diff")
  assert.deepEqual(result.context.delta.changed_files, ["src/app.js"])
  assert.match(result.deltaText, /value = 2/u)
})

test("rebase-equivalent force push sends range comparison to the gate", () => {
  const { repo, reviewed, defaultBranch } = createRepo()
  git(repo, ["checkout", defaultBranch])
  write(repo, "README.md", "base\nnew base\n")
  const newBase = commit(repo, "base update")
  git(repo, ["checkout", "-b", "feature-rebased"])
  write(repo, "src/app.js", "export const value = 1;\n")
  const head = commit(repo, "feature reviewed rebased")
  const context = reviewContext({
    reason: "synchronize",
    base: newBase,
    head,
    reviews: [botReview(reviewed)]
  })
  const result = prepareGate({
    context,
    workspace: repo,
    diffText: git(repo, ["diff", `${newBase}..${head}`]),
    botLogin
  })

  assert.equal(result.action, "run-gate")
  assert.equal(result.context.delta.mode, "rebase_compare")
  assert.equal(result.context.delta.patch_ids_match, true)
  assert.match(result.deltaText, /range-diff:/u)
})

test("mention trigger can use the gate even before the first completed review", () => {
  const { repo, base, reviewed } = createRepo()
  const context = reviewContext({ reason: "mention", base, head: reviewed, reviews: [] })
  const result = prepareGate({ context, workspace: repo, diffText: "diff", botLogin })

  assert.equal(result.action, "run-gate")
  assert.equal(result.context.delta.mode, "no_previous_review")
})

test("mention retry request bypasses the gate even when the same head was reviewed", () => {
  const { repo, base, reviewed } = createRepo()
  const context = reviewContext({
    reason: "mention",
    base,
    head: reviewed,
    reviews: [botReview(reviewed)],
    commentBody: "@singular-code-review can you try again?"
  })
  const result = prepareGate({ context, workspace: repo, diffText: "diff", botLogin })

  assert.deepEqual(result, { action: "run-review", reason: "mention explicitly requested a full review" })
})

test("mention with incidental try again wording still uses the gate", () => {
  const { repo, base, reviewed } = createRepo()
  const context = reviewContext({
    reason: "mention",
    base,
    head: reviewed,
    reviews: [botReview(reviewed)],
    commentBody: "@singular-code-review why did the previous review tell me to try again?"
  })
  const result = prepareGate({ context, workspace: repo, diffText: "diff", botLogin })

  assert.equal(result.action, "run-gate")
  assert.equal(result.context.delta.mode, "same_head")
})
