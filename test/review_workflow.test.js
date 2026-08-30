import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

import { ReviewQueue } from "../dist/lib/review-queue.js"
import { runReview } from "../dist/run-review.js"
import { GitHubReviewSession } from "../dist/services/github-session.js"
import { createGitHubReadTools } from "../dist/tools/github-read.js"
import { createReviewTools } from "../dist/tools/review.js"

const laneNames = [
  "intent-contract",
  "standards-architecture",
  "code-path-bug-hunter",
  "correctness-risk-testing",
  "documentation-commentary",
  "maintainability-elegance"
]

const diff = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,2 +10,3 @@
 const first = true
 const second = true
+const changed = true
`

const finding = {
  kind: "inline",
  severity: "high",
  body: "This branch accepts stale state and returns the wrong result; preserve the freshness guard before returning.",
  evidence: "The added assignment bypasses the freshness result.",
  confidence: "high",
  path: "src/example.ts",
  line: 12,
  side: "RIGHT"
}

function laneName(prompt) {
  return laneNames.find(name => prompt.includes(`Your lane is \`${name}\`.`))
}

function fakeGitHub(overrides = {}) {
  const writes = []
  const client = {
    async getPullRequest(prNumber) {
      return {
        number: prNumber,
        title: "Reject stale state",
        body: "Keep responses fresh.",
        author: { login: "author" },
        baseRefName: "main",
        headRefName: "feature",
        baseRefOid: "1111111111111111111111111111111111111111",
        headRefOid: "2222222222222222222222222222222222222222",
        isDraft: false,
        ...overrides.pullRequest
      }
    },
    async getPullRequestDiff() {
      return overrides.diff ?? diff
    },
    async getIssueComment(commentId) {
      return { id: commentId, body: "please review", user: { login: "author" } }
    },
    async listIssueComments() {
      return overrides.issueComments ?? []
    },
    async listReviewComments() {
      return overrides.reviewComments ?? []
    },
    async listReviews() {
      return overrides.reviews ?? []
    },
    async listPullRequestCommits() {
      return (
        overrides.commits ?? [
          {
            sha: "2222222222222222222222222222222222222222",
            author: { login: "author" },
            commit: { message: "fix stale state", author: { date: "2026-08-29T12:00:00Z" } }
          }
        ]
      )
    },
    async listReviewThreads() {
      return overrides.reviewThreads ?? { available: true, threads: [] }
    },
    async listIssueCommentReactions() {
      return []
    },
    async createIssueCommentReaction(commentId, content) {
      writes.push({ kind: "reaction", commentId, content })
    },
    async createIssueComment(prNumber, body) {
      writes.push({ kind: "issue-comment", prNumber, body })
    },
    async submitReviewAtHead(prNumber, headSha, payload) {
      writes.push({ kind: "review", prNumber, headSha, payload })
    },
    async submitReply(prNumber, commentId, body) {
      writes.push({ kind: "reply", prNumber, commentId, body })
    }
  }
  return { client, writes }
}

function reviewOptions(t, github, overrides = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aml-review-"))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  return {
    request: {
      repository: "owner/repository",
      prNumber: 42,
      workspace,
      workspaceHeadSha: "2222222222222222222222222222222222222222",
      botLogin: "singular-code-review[bot]",
      eventName: null,
      eventPath: null,
      actor: "author",
      ignoreHistory: false
    },
    github,
    actionMode: "dry-run",
    provider: "opencode",
    model: "opencode-go/deepseek-v4-flash",
    maximumConcurrency: 6,
    ...overrides
  }
}

async function executeTool(request, context, name, input = {}) {
  const tool = request.tools.find(candidate => candidate.name === name)
  assert.ok(tool, `${name} was not granted to the Agent`)
  return tool.execute(input, context)
}

function commentInput(value) {
  const { kind: _kind, comment_type: _commentType, ...input } = value
  return input
}

test("GitHub reference Tools resolve linked evidence through the cached read boundary", async () => {
  const calls = []
  const session = new GitHubReviewSession(
    {
      async getPullRequest(number, repository) {
        calls.push(["pull", repository, number])
        return { number, title: "Referenced pull request" }
      },
      async getPullRequestDiff(number, repository) {
        calls.push(["diff", repository, number])
        return diff
      },
      async getIssue(number, repository) {
        calls.push(["issue", repository, number])
        return { number, title: "Referenced issue" }
      },
      async listIssueComments(number, repository) {
        calls.push(["comments", repository, number])
        return [{ id: 7, body: "Decision recorded here." }]
      },
      async getCommit(ref, repository) {
        calls.push(["commit", repository, ref])
        return { sha: ref, commit: { message: "Referenced commit" } }
      }
    },
    {
      repository: "owner/repository",
      prNumber: 42,
      workspace: "/workspace",
      workspaceHeadSha: "2".repeat(40),
      botLogin: "review-bot",
      eventName: null,
      eventPath: null,
      actor: null,
      ignoreHistory: false
    }
  )
  const tools = createGitHubReadTools(session)

  await tools.getIssue.execute({ issue_number: 17, repository: "linked/project" })
  await tools.getIssue.execute({ issue_number: 17, repository: "linked/project" })
  await tools.getCommit.execute({ ref: "abc1234" })

  assert.deepEqual(calls, [
    ["issue", "linked/project", 17],
    ["commit", "owner/repository", "abc1234"]
  ])
})

function reviewProvider(options = {}) {
  const laneInputs = options.laneInputs ?? { "code-path-bug-hunter": [commentInput(finding)] }

  return new DeterministicAgentProvider({
    name: "aml-review-test",
    async respond(request, context) {
      if (request.system.includes("route pull-request follow-up") && options.gate) {
        return { text: "", structured: options.gate }
      }
      const lane = laneName(request.prompt)
      if (lane) {
        for (const input of laneInputs[lane] || []) {
          if (input.kind === "reply") {
            const { kind: _kind, to, ...reply } = input
            await executeTool(request, context, "add_review_reply", { comment_id: to, ...reply })
          } else if (input.kind === "blocker") {
            const { kind: _kind, severity: _severity, confidence: _confidence, ...blocker } = input
            await executeTool(request, context, "add_review_blocker", blocker)
          } else {
            await executeTool(request, context, "add_review_comment", input)
          }
        }
        return {
          text: options.laneSummaries?.[lane] || `${lane} checked its relevant scope; no additional issue remains.`
        }
      }

      if (request.system.includes("calibrate pull-request findings")) {
        if (options.auditFailure) {
          throw new Error("audit unavailable")
        }
        for (const action of options.auditActions || []) {
          await executeTool(request, context, action.tool, action.input)
        }
        return { text: options.auditSummary || "The staged findings were consolidated." }
      }

      if (request.system.includes("concise pull-request review summary")) {
        return {
          text: "",
          structured: options.synthesis ?? {
            direct_answer: null,
            summary: "The change is focused, but retained feedback should be resolved before it is ready.",
            next_steps: null
          }
        }
      }

      throw new Error(`unexpected Agent: ${request.system}`)
    }
  })
}

test("the declarative tree carries Tool findings through audit, validation, synthesis, and publication", async t => {
  const github = fakeGitHub()
  const provider = reviewProvider({
    laneSummaries: {
      "code-path-bug-hunter": "The stale-state branch remains reachable and was queued for audit."
    }
  })
  const result = await runReview(reviewOptions(t, github.client), () => provider)

  assert.equal(result.status, "reviewed")
  assert.deepEqual(
    result.lanes.map(lane => lane.lane),
    laneNames
  )
  assert.equal(result.lanes[2].summary, "The stale-state branch remains reachable and was queued for audit.")
  assert.equal(Object.hasOwn(result, "laneFailures"), false)
  assert.equal(result.validated.inlineComments.length, 1)
  assert.match(result.validated.inlineComments[0].body, /^\*\*high:\*\* This branch accepts stale state/u)
  assert.match(result.body, /^> reviewer · deepseek-v4-flash/u)
  assert.match(result.body, /## Verdict\n\n⚠️ Request changes$/u)
  assert.equal(result.publication.find(receipt => receipt.kind === "review")?.status, "prepared")
  assert.deepEqual(github.writes, [])

  const laneCalls = provider.calls.filter(call => Boolean(laneName(call.request.prompt)))
  assert.equal(laneCalls.length, 6)
  for (const call of laneCalls) {
    assert.deepEqual(
      call.request.tools.map(tool => tool.name),
      [
        "get_pull_request",
        "get_pull_request_diff",
        "get_issue",
        "list_issue_comments",
        "get_commit",
        "add_review_comment",
        "add_review_reply",
        "add_review_blocker"
      ]
    )
    assert.doesNotMatch(call.request.system, /add_review_comment/u)
    const policyIndex = call.request.prompt.indexOf("# Evidence-first review lane")
    const contextIndex = call.request.prompt.indexOf("## Review context")
    const assignmentIndex = call.request.prompt.indexOf("## Lane assignment")
    assert.ok(policyIndex >= 0)
    assert.ok(policyIndex < contextIndex)
    assert.ok(contextIndex < assignmentIndex)
    assert.match(call.request.prompt, /\n\n## Review context/u)
    assert.match(call.request.prompt, /\.singular-code-review\/pr\.md/u)
    assert.match(call.request.prompt, /\.singular-code-review\/pr\.diff/u)
    assert.match(call.request.prompt, /\.singular-code-review\/history\.md/u)
    assert.match(call.request.prompt, /Audit owns retention, semantic deduplication, and calibration/u)
    assert.match(call.request.prompt, /Synthesis writes the top-level review summary/u)
    assert.match(call.request.prompt, /A `low` finding never describes itself as optional/u)
    assert.match(call.request.prompt, /A `nit` does not need a failure mode/u)
    assert.match(call.request.prompt, /not a request for the author to investigate a hypothetical mechanism/u)
    assert.match(call.request.prompt, /material present structural cost/u)
    assert.match(call.request.prompt, /concrete responsibility boundary/u)
    assert.match(call.request.prompt, /The pull request may merge unchanged/u)
    assert.doesNotMatch(call.request.prompt, /`hint`/u)
    assert.match(call.request.prompt, /exact server-qualified names/u)
    assert.match(call.request.prompt, /without MCP resource discovery/u)
    assert.match(call.request.prompt, /final text the author will see/u)
    assert.match(call.request.prompt, /`low` finding to two or three concise sentences/u)
    assert.match(call.request.prompt, /repository-relative `path`/u)
    assert.match(call.request.prompt, /inclusive range such as `"40-42"`/u)
    assert.match(call.request.prompt, /fenced `suggestion` block inside `body`/u)
    assert.match(call.request.prompt, /a reply has no severity or confidence/u)
    assert.match(call.request.prompt, /explicitly references another pull request, issue, or commit/u)
    assert.doesNotMatch(call.request.prompt, /const changed = true/u)
  }

  for (const call of laneCalls) {
    assert.deepEqual(
      call.request.mcpServers.map(server => server.definition.name),
      ["context7"]
    )
  }

  const maintainabilityCall = laneCalls.find(call => laneName(call.request.prompt) === "maintainability-elegance")
  assert.ok(maintainabilityCall)
  assert.match(maintainabilityCall.request.prompt, /concept count/u)
  assert.match(maintainabilityCall.request.prompt, /names, comments, file placement, inferred types, unused exports/u)
  assert.match(maintainabilityCall.request.prompt, /indirection without simplification/u)
  assert.match(maintainabilityCall.request.prompt, /above 500 lines/u)
  assert.match(maintainabilityCall.request.prompt, /helpers, functions, types, schemas, or responsibilities/u)
  assert.match(maintainabilityCall.request.prompt, /comments, docblocks, or structural cues/u)
  assert.match(
    maintainabilityCall.request.prompt,
    /generated, vendored, external, build, migration, and maintenance scripts/u
  )
  assert.match(maintainabilityCall.request.prompt, /line count alone is never a finding/u)
  assert.match(maintainabilityCall.request.prompt, /type-only coupling, generated-file markers/u)

  const codePathCall = laneCalls.find(call => laneName(call.request.prompt) === "code-path-bug-hunter")
  assert.ok(codePathCall)
  assert.match(codePathCall.request.prompt, /populated to empty or withheld/u)
  assert.match(codePathCall.request.prompt, /repository-supported producer and consumer pair/u)

  const documentationCall = laneCalls.find(call => laneName(call.request.prompt) === "documentation-commentary")
  assert.ok(documentationCall)
  assert.match(documentationCall.request.prompt, /concrete incorrect use, rollout, or operator action/u)

  const audit = provider.calls.find(call => call.request.system.includes("calibrate pull-request findings"))
  assert.ok(audit)
  assert.deepEqual(
    audit.request.tools.map(tool => tool.name),
    ["merge_review_findings", "demote_review_finding", "drop_review_findings"]
  )
  assert.deepEqual(audit.request.mcpServers, [])
  assert.match(audit.request.prompt, /staged_findings/u)
  assert.match(audit.request.prompt, /"id": "BUG-1"/u)
  assert.match(audit.request.prompt, /This branch accepts stale state/u)
  assert.match(audit.request.prompt, /`critical` → `high` → `low` → `nit` → drop/u)
  assert.match(audit.request.prompt, /unchanged body remains author-ready at the lower severity/u)
  assert.match(audit.request.prompt, /Demote a `low` whose wording makes the action optional/u)
  assert.match(audit.request.prompt, /merge-action counterfactual/u)
  assert.match(audit.request.prompt, /Treat factuality and merge action separately/u)
  assert.match(audit.request.prompt, /undocumented older or third-party compatibility/u)
  assert.match(audit.request.prompt, /An anchorless blocker can only remain `critical` or be dropped/u)
  assert.doesNotMatch(audit.request.prompt, /lane_assessments/u)
  assert.doesNotMatch(audit.request.prompt, /\.singular-code-review\/pr\.diff/u)

  const synthesis = provider.calls.find(call => call.request.system.includes("concise pull-request review summary"))
  assert.ok(synthesis)
  assert.deepEqual(synthesis.request.tools, [])
  assert.match(synthesis.request.prompt, /lane_assessments/u)
  assert.match(synthesis.request.prompt, /"final_review"/u)
  assert.match(synthesis.request.prompt, /"verdict": "⚠️ Request changes"/u)
  assert.match(synthesis.request.prompt, /at most 80 words/u)
  assert.match(synthesis.request.prompt, /not another findings channel/u)
  assert.match(synthesis.request.prompt, /Set next_steps only for a Request changes or Block review/u)
  assert.match(synthesis.request.prompt, /at most 50 words/u)
  assert.doesNotMatch(synthesis.request.prompt, /retained_findings/u)
  assert.doesNotMatch(synthesis.request.prompt, /inline_comments/u)
  assert.doesNotMatch(synthesis.request.prompt, /const changed = true/u)
})

test("native Parallel starts all six specialists concurrently", { timeout: 2_000 }, async t => {
  const github = fakeGitHub()
  let active = 0
  let maximumActive = 0
  const started = []
  let releaseLanes
  const release = new Promise(resolve => {
    releaseLanes = resolve
  })
  let allStarted
  const ready = new Promise(resolve => {
    allStarted = resolve
  })
  const provider = new DeterministicAgentProvider({
    async respond(request, _context) {
      const lane = laneName(request.prompt)
      if (lane) {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        started.push(lane)
        if (started.length === laneNames.length) {
          allStarted()
        }
        await release
        active -= 1
        return { text: `${lane} completed.` }
      }
      if (request.system.includes("concise pull-request review summary")) {
        return {
          text: "",
          structured: { direct_answer: null, summary: "The focused change is ready.", next_steps: null }
        }
      }
      throw new Error(`unexpected Agent: ${request.system}`)
    }
  })

  const running = runReview(reviewOptions(t, github.client), () => provider)
  await ready
  assert.equal(maximumActive, 6)
  assert.deepEqual(new Set(started), new Set(laneNames))
  releaseLanes()

  const result = await running
  assert.equal(result.status, "reviewed")
  assert.match(result.body, /✅ LGTM$/u)
})

test("request-changes synthesis may coordinate next steps without restating findings", async t => {
  const github = fakeGitHub()
  const provider = reviewProvider({
    synthesis: {
      direct_answer: null,
      summary: "The change is focused, but retained feedback should be resolved before it is ready.",
      next_steps:
        "Prioritize the behavior-changing feedback, verify the affected paths together, and apply optional cleanup afterward."
    }
  })

  const result = await runReview(reviewOptions(t, github.client), () => provider)

  assert.match(
    result.body,
    /## Recommendations\n\nPrioritize the behavior-changing feedback, verify the affected paths together, and apply optional cleanup afterward\.\n\n## Verdict/u
  )
  assert.match(result.body, /⚠️ Request changes$/u)
})

test("every lane remains available for documentation-only changes and may return compactly", async t => {
  const documentationDiff = `diff --git a/docs/review.md b/docs/review.md
index 1111111..2222222 100644
--- a/docs/review.md
+++ b/docs/review.md
@@ -1 +1,2 @@
 Existing guidance.
+New guidance.
`
  const github = fakeGitHub({ diff: documentationDiff })
  const provider = reviewProvider({ laneInputs: {} })
  const result = await runReview(reviewOptions(t, github.client), () => provider)

  assert.equal(provider.calls.filter(call => Boolean(laneName(call.request.prompt))).length, 6)
  assert.equal(result.lanes.length, 6)
  assert.match(result.body, /✅ LGTM$/u)
})

test("review Tools validate anchors, preserve cross-lane agreement, and coalesce one lane's retry", async () => {
  const reviews = new ReviewQueue(queueOptions())
  const bugHunter = createReviewTools(reviews, "code-path-bug-hunter")
  const correctness = createReviewTools(reviews, "correctness-risk-testing")
  const context = { signal: new AbortController().signal }
  const input = commentInput(finding)

  assert.equal(bugHunter.addReviewComment.inputSchema.type, "object")
  assert.equal(Object.hasOwn(bugHunter.addReviewComment.inputSchema, "oneOf"), false)
  assert.equal(Object.hasOwn(bugHunter.addReviewComment.inputSchema, "anyOf"), false)
  assert.deepEqual(Object.keys(bugHunter.addReviewComment.inputSchema.properties).sort(), [
    "body",
    "confidence",
    "evidence",
    "line",
    "path",
    "severity",
    "side"
  ])
  assert.deepEqual(
    bugHunter.addReviewComment.inputSchema.properties.line.anyOf.map(option => option.type),
    ["integer", "string", "array"]
  )
  await assert.rejects(
    bugHunter.addReviewComment.execute({ ...input, path: "src/not-changed.ts" }, context),
    /cannot queue review comment: path is not present in the PR diff/u
  )
  assert.equal((await bugHunter.addReviewComment.execute(input, context)).id, "BUG-1")
  assert.equal((await bugHunter.addReviewComment.execute(input, context)).id, "BUG-1")
  assert.equal((await correctness.addReviewComment.execute(input, context)).id, "RISK-1")
  assert.deepEqual(
    reviews.staged().map(candidate => candidate.id),
    ["BUG-1", "RISK-1"]
  )
  assert.equal(reviews.staged().length, 2)

  reviews.beginAudit()
  reviews.merge("BUG-1", ["RISK-1"])
  assert.throws(() => reviews.drop(["RISK-1"]), /unknown or inactive review finding id: RISK-1/u)
})

test("review comment Tool normalizes familiar single-line and same-side range notation", async () => {
  const reviews = new ReviewQueue(queueOptions())
  const tool = createReviewTools(reviews, "code-path-bug-hunter").addReviewComment
  const context = { signal: new AbortController().signal }
  const input = commentInput(finding)

  for (const line of [12, "12", [11, 12], [12, 11], "11-12", "11..12", "11,12", "L11-L12"]) {
    assert.equal((await tool.execute({ ...input, line }, context)).id, line === 12 || line === "12" ? "BUG-1" : "BUG-2")
  }
  await assert.rejects(tool.execute({ ...input, line: "current change" }, context), /positive integer/u)
  await assert.rejects(tool.execute({ ...input, line: "9-12" }, context), /range is not fully present/u)

  assert.deepEqual(
    reviews.staged().map(candidate => ({
      line: candidate.finding.line,
      start_line: candidate.finding.start_line,
      start_side: candidate.finding.start_side
    })),
    [
      { line: 12, start_line: undefined, start_side: undefined },
      { line: 12, start_line: 11, start_side: "RIGHT" }
    ]
  )
})

test("review finding IDs expose stable semantic lane prefixes", () => {
  const reviews = new ReviewQueue(queueOptions())
  const expected = ["INT-1", "ARCH-1", "BUG-1", "RISK-1", "DOC-1", "ELE-1"]

  assert.deepEqual(
    laneNames.map(lane => reviews.add(lane, finding).id),
    expected
  )
})

test("review Tools keep inline suggestions and thread replies in one findings owner", async () => {
  const reviews = new ReviewQueue(queueOptions())
  const tools = createReviewTools(reviews, "code-path-bug-hunter")
  const context = { signal: new AbortController().signal }

  await tools.addReviewComment.execute(
    {
      severity: "high",
      body: "This assignment disables the guard for every response.\n\n```suggestion\nconst changed = false\n```",
      evidence: "The added assignment is read by the response guard.",
      confidence: "high",
      path: "src/example.ts",
      line: 12,
      side: "RIGHT"
    },
    context
  )
  await tools.addReviewReply.execute(
    {
      body: "The new guard leaves the stale-state path reachable.",
      evidence: "The changed branch does not cover the prior top-level concern.",
      comment_id: 123
    },
    context
  )

  const staged = reviews.staged().map(item => item.finding)
  assert.equal(staged[0].kind, "inline")
  assert.equal(staged[0].comment_type, "suggestion")
  assert.match(staged[0].body, /```suggestion\nconst changed = false\n```/u)
  assert.equal(staged[1].kind, "reply")
  assert.equal(staged[1].to, 123)
  assert.equal(Object.hasOwn(staged[1], "severity"), false)

  assert.deepEqual(Object.keys(tools.addReviewReply.inputSchema.properties).sort(), ["body", "comment_id", "evidence"])
  assert.equal(tools.addReviewReply.inputSchema.additionalProperties, false)
})

test("review blocker Tool fixes critical severity and remains separate from inline publication", async t => {
  const blocker = {
    kind: "blocker",
    severity: "critical",
    body: "The proposed contract cannot safely land until the incompatible behavior is removed.",
    evidence: "The PR-level contract requires mutually incompatible behavior across every changed package.",
    confidence: "high"
  }
  const github = fakeGitHub()
  const provider = reviewProvider({
    laneInputs: {
      "standards-architecture": [blocker],
      "code-path-bug-hunter": [commentInput(finding)]
    },
    synthesis: {
      direct_answer: null,
      summary: "The implementation contains useful work, but a retained critical contract conflict prevents landing.",
      next_steps: "Resolve the review-level blocker first, then verify the remaining changed behavior together."
    }
  })
  const result = await runReview(reviewOptions(t, github.client), () => provider)

  const retainedBlocker = result.audit.findings.find(candidate => candidate.kind === "blocker")
  assert.equal(retainedBlocker?.severity, "critical")
  assert.equal(result.validated.inlineComments.length, 1)
  assert.match(result.body, /## Recommendations\n\n- The proposed contract cannot safely land/u)
  assert.match(result.body, /incompatible behavior is removed\.\n\nResolve the review-level blocker first/u)
  assert.doesNotMatch(result.body, /stale state/u)
  assert.match(result.body, /## Verdict\n\n⛔ Block$/u)

  const tools = createReviewTools(new ReviewQueue(queueOptions()), "standards-architecture")
  assert.deepEqual(Object.keys(tools.addReviewBlocker.inputSchema.properties).sort(), ["body", "evidence"])
  assert.equal(tools.addReviewBlocker.inputSchema.additionalProperties, false)
})

test("audit merges semantic duplicates without rewriting the retained finding", async t => {
  const github = fakeGitHub()
  const duplicate = { ...finding, evidence: "A second lane traced the same stale-state mechanism." }
  const provider = reviewProvider({
    laneInputs: {
      "code-path-bug-hunter": [commentInput(finding)],
      "correctness-risk-testing": [commentInput(duplicate)]
    },
    auditActions: [
      {
        tool: "merge_review_findings",
        input: { keep: "BUG-1", duplicates: ["RISK-1"] }
      }
    ]
  })

  const result = await runReview(reviewOptions(t, github.client), () => provider)
  assert.deepEqual(result.audit.findings, [finding])
  assert.equal(result.validated.inlineComments.length, 1)
  assert.deepEqual(github.writes, [])
})

test("audit demotes a useful optional low to nit without rewriting it", async t => {
  const github = fakeGitHub()
  const optionalLow = {
    ...finding,
    severity: "low",
    body: "Consider aligning this local name with the surrounding terminology; the pull request may merge unchanged."
  }
  const provider = reviewProvider({
    laneInputs: { "maintainability-elegance": [commentInput(optionalLow)] },
    auditActions: [{ tool: "demote_review_finding", input: { id: "ELE-1" } }],
    synthesis: {
      direct_answer: null,
      summary: "The focused change is ready to land with one optional cleanup note.",
      next_steps: null
    }
  })

  const result = await runReview(reviewOptions(t, github.client), () => provider)
  assert.deepEqual(result.audit.findings, [{ ...optionalLow, severity: "nit" }])
  assert.match(result.validated.inlineComments[0].body, /^\*\*nit:\*\* Consider aligning this local name/u)
  assert.match(result.body, /✅ LGTM$/u)
})

test("audit rejects an unknown or inactive finding id", async t => {
  const github = fakeGitHub()
  const provider = reviewProvider({
    auditActions: [{ tool: "drop_review_findings", input: { ids: ["XX-1"] } }]
  })

  await assert.rejects(
    runReview(reviewOptions(t, github.client), () => provider),
    /drop_review_findings.*input failed schema validation/u
  )
  assert.deepEqual(github.writes, [])
})

test("audit drops findings without needing a replacement result schema", async t => {
  const github = fakeGitHub()
  const provider = reviewProvider({
    auditActions: [{ tool: "drop_review_findings", input: { ids: ["BUG-1"] } }],
    synthesis: {
      direct_answer: null,
      summary: "The focused change is ready to land.",
      next_steps: null
    }
  })

  const result = await runReview(reviewOptions(t, github.client), () => provider)
  assert.deepEqual(result.audit.findings, [])
  assert.match(result.body, /✅ LGTM$/u)
})

test("an audit failure is terminal and never falls back to unaudited lane findings", async t => {
  const github = fakeGitHub()
  const provider = reviewProvider({ auditFailure: true })

  await assert.rejects(
    runReview(reviewOptions(t, github.client), () => provider),
    /audit unavailable/u
  )
  assert.equal(provider.calls.filter(call => call.request.system.includes("calibrate pull-request findings")).length, 1)
  assert.equal(
    provider.calls.some(call => call.request.system.includes("concise pull-request review summary")),
    false
  )
  assert.deepEqual(github.writes, [])
})

test("zero-finding reviews skip semantic audit and synthesize a compact LGTM", async t => {
  const github = fakeGitHub()
  const provider = reviewProvider({
    laneInputs: {},
    synthesis: {
      direct_answer: null,
      summary: "The focused change preserves the existing behavior and is ready.",
      next_steps: "Resolve the staged concern before merging."
    }
  })
  const result = await runReview(reviewOptions(t, github.client), () => provider)

  assert.equal(
    provider.calls.some(call => call.request.system.includes("calibrate pull-request findings")),
    false
  )
  assert.equal(provider.calls.filter(call => Boolean(laneName(call.request.prompt))).length, 6)
  assert.equal(
    provider.calls.filter(call => call.request.system.includes("concise pull-request review summary")).length,
    1
  )
  assert.match(result.body, /## Verdict\n\n✅ LGTM$/u)
  assert.doesNotMatch(result.body, /## Recommendations/u)
  assert.doesNotMatch(result.body, /Resolve the staged concern/u)
  assert.equal(result.validated.inlineComments.length, 0)
})

test("lane terminal prose is never promoted into the canonical findings queue", async t => {
  const github = fakeGitHub()
  const provider = reviewProvider({
    laneInputs: {},
    laneSummaries: {
      "code-path-bug-hunter": "A possible regression was observed but was not staged through a review Tool."
    },
    synthesis: {
      direct_answer: null,
      summary: "The focused change is ready to land.",
      next_steps: null
    }
  })

  const result = await runReview(reviewOptions(t, github.client), () => provider)

  assert.equal(result.audit.findings.length, 0)
  assert.equal(result.validated.inlineComments.length, 0)
  assert.match(result.body, /## Verdict\n\n✅ LGTM$/u)
  assert.equal(
    provider.calls.some(call => call.request.system.includes("calibrate pull-request findings")),
    false
  )
})

test("typed retained severity owns the verdict instead of synthesis prose", async t => {
  const nit = { ...finding, severity: "nit", body: "Align this name with the surrounding module terminology." }
  const low = {
    ...finding,
    severity: "low",
    body: "This reachable branch returns the wrong result; preserve the guard."
  }
  const critical = { ...finding, severity: "critical", body: "This change exposes data across tenant boundaries." }

  for (const [retained, expected] of [
    [nit, "✅ LGTM"],
    [low, "⚠️ Request changes"],
    [critical, "⛔ Block"]
  ]) {
    const github = fakeGitHub()
    const provider = reviewProvider({
      laneInputs: { "code-path-bug-hunter": [commentInput(retained)] },
      synthesis: { direct_answer: null, summary: "The model does not choose the verdict.", next_steps: null }
    })
    const result = await runReview(reviewOptions(t, github.client), () => provider)
    assert.equal(result.body.endsWith(expected), true)
  }
})

test("deterministic validation drops an existing bot finding before deriving the verdict", async t => {
  const body =
    "**high:** This branch accepts stale state and returns the wrong result; preserve the freshness guard before returning."
  const github = fakeGitHub({
    reviewThreads: { available: false, threads: [] },
    reviewComments: [
      {
        id: 900,
        user: { login: "singular-code-review[bot]" },
        body,
        path: "src/example.ts",
        line: 12,
        side: "RIGHT",
        created_at: "2026-08-29T12:00:00Z"
      }
    ]
  })
  const provider = reviewProvider({
    synthesis: {
      direct_answer: null,
      summary: "The current change has no new author action after validation.",
      next_steps: null
    }
  })
  const result = await runReview(reviewOptions(t, github.client), () => provider)

  assert.equal(result.audit.findings.length, 1)
  assert.equal(result.validated.inlineComments.length, 0)
  assert.match(result.body, /✅ LGTM$/u)
})

test("full reviews preserve a direct trigger answer before the review summary", async t => {
  const github = fakeGitHub()
  const options = reviewOptions(t, github.client)
  const eventFile = path.join(options.request.workspace, "event.json")
  fs.writeFileSync(
    eventFile,
    JSON.stringify({
      action: "created",
      comment: {
        id: 77,
        body: "@singular-code-review please review this and tell me whether stale responses stay blocked",
        user: { login: "author" }
      },
      sender: { login: "author" }
    })
  )
  options.request = { ...options.request, eventName: "issue_comment", eventPath: eventFile }
  const provider = reviewProvider({
    gate: { decision: "review", reason: "The direct question accompanies a requested full review." },
    laneInputs: {},
    synthesis: {
      direct_answer: "@author Yes. The reviewed path still blocks stale responses.",
      summary: "The focused change preserves the stale-response guard and is ready.",
      next_steps: null
    }
  })

  const result = await runReview(options, () => provider)
  assert.match(
    result.body,
    /^> reviewer · deepseek-v4-flash\n\n@author Yes\. The reviewed path still blocks stale responses\.\n\n## Review Summary/u
  )
  const synthesis = provider.calls.find(call => call.request.system.includes("concise pull-request review summary"))
  assert.match(synthesis.request.prompt, /"participants": \[\n\s+"@author"/u)
  assert.match(synthesis.request.prompt, /please review this and tell me whether stale responses stay blocked/u)
})

test("thread-only reply requests cannot leak into the top-level review body", async t => {
  const github = fakeGitHub({
    reviewComments: [
      {
        id: 123,
        user: { login: "singular-code-review[bot]" },
        body: "The stale-state path remains reachable.",
        path: "src/example.ts",
        line: 12,
        side: "RIGHT",
        created_at: "2026-08-29T12:00:00Z"
      }
    ],
    reviewThreads: {
      available: true,
      threads: [
        {
          id: "thread-123",
          is_resolved: false,
          is_outdated: false,
          path: "src/example.ts",
          line: 12,
          start_line: null,
          side: "RIGHT",
          start_side: null,
          top_level_comment_id: 123,
          top_level_author: "singular-code-review[bot]",
          latest_author: "author",
          latest_comment_id: 124,
          comments: [
            { id: 123, body: "The stale-state path remains reachable.", user: { login: "singular-code-review[bot]" } },
            { id: 124, body: "Does the latest push resolve this?", user: { login: "author" } }
          ]
        }
      ]
    }
  })
  const provider = reviewProvider({
    laneInputs: {
      "code-path-bug-hunter": [
        {
          kind: "reply",
          to: 123,
          body: "Yes. The latest push resolves this thread.",
          evidence: "The changed guard now covers the stale-state path raised by comment 123."
        }
      ]
    },
    synthesis: {
      direct_answer: "@author Yes. The latest push resolves the thread.",
      summary: "The focused change preserves the stale-response guard and is ready.",
      next_steps: null
    }
  })

  const result = await runReview(reviewOptions(t, github.client), () => provider)
  assert.doesNotMatch(result.body, /latest push resolves the thread/u)
  assert.match(result.body, /^> reviewer · deepseek-v4-flash\n\n## Review Summary/u)
  assert.deepEqual(result.validated.replies, [{ to: 123, body: "Yes. The latest push resolves this thread." }])
  assert.match(result.body, /✅ LGTM$/u)

  const synthesis = provider.calls.find(call => call.request.system.includes("concise pull-request review summary"))
  assert.match(synthesis.request.prompt, /"top_level_action_items": \[\]/u)
  assert.doesNotMatch(synthesis.request.prompt, /Does the latest push resolve this\?/u)
})

function queueOptions() {
  return {
    botLogin: "singular-code-review[bot]",
    commentRanges: {
      "src/example.ts": {
        added_lines: [12],
        deleted_lines: [],
        left_lines: [10, 11],
        right_lines: [10, 11, 12]
      }
    },
    reviewThreadsAvailable: false,
    unresolvedBotThreads: [],
    reviewComments: [
      {
        id: 123,
        in_reply_to_id: null,
        user: { login: "author" },
        path: "src/example.ts",
        line: 12,
        start_line: null,
        side: "RIGHT",
        start_side: null,
        body: "Does this still apply?"
      }
    ]
  }
}
