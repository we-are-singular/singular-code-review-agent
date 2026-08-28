import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

import { ReviewFindings } from "../dist/aml/services/review-findings.js"
import { runReview } from "../dist/aml/runtime.js"
import { createReviewTools } from "../dist/aml/tools/review.js"

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
  title: "Reject stale state",
  body: "This branch accepts stale state and returns the wrong result.",
  evidence: "The added assignment bypasses the freshness result.",
  confidence: "high",
  path: "src/example.ts",
  line: 12,
  side: "RIGHT"
}

const readToolNames = [
  "get_pull_request",
  "get_pull_request_diff",
  "get_issue_comment",
  "list_issue_comments",
  "list_review_comments",
  "list_reviews",
  "list_pull_request_commits",
  "list_review_threads",
  "list_issue_comment_reactions"
]

function laneName(prompt) {
  return laneNames.find(name => prompt.includes(`Your lane is ${name}.`))
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
  return { kind: "comment", ...input }
}

function reviewProvider(options = {}) {
  const auditedFindings = options.auditFindings ?? [finding]
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
            const { kind: _kind, ...reply } = input
            await executeTool(request, context, "add_review_reply", reply)
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
        return {
          text: "",
          structured: { findings: auditedFindings }
        }
      }

      if (request.system.includes("concise pull-request review summary")) {
        return {
          text: "",
          structured: options.synthesis ?? {
            direct_answer: null,
            summary: "The change is focused, but one correctness issue remains before it is ready.",
            recommendation: null
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
  assert.match(result.validated.inlineComments[0].body, /^\*\*high:\*\* Reject stale state/u)
  assert.match(result.body, /^> reviewer · deepseek-v4-flash/u)
  assert.match(result.body, /## Verdict\n\n⚠️ Request changes$/u)
  assert.equal(result.publication.find(receipt => receipt.kind === "review")?.status, "prepared")
  assert.deepEqual(github.writes, [])

  const laneCalls = provider.calls.filter(call => Boolean(laneName(call.request.prompt)))
  assert.equal(laneCalls.length, 6)
  for (const call of laneCalls) {
    assert.deepEqual(
      call.request.tools.map(tool => tool.name),
      [...readToolNames, "add_review_comment", "add_review_reply", "add_review_blocker"]
    )
    assert.match(call.request.system, /AML guarantees these callable Tools/u)
    assert.match(call.request.system, /Never query MCP resources/u)
    assert.match(call.request.prompt, /\.singular-code-review\/pr\.md/u)
    assert.match(call.request.prompt, /\.singular-code-review\/pr\.diff/u)
    assert.match(call.request.prompt, /\.singular-code-review\/history\.md/u)
    assert.doesNotMatch(call.request.prompt, /const changed = true/u)
  }

  for (const call of laneCalls) {
    assert.deepEqual(
      call.request.mcpServers.map(server => server.definition.name),
      ["context7"]
    )
  }

  const audit = provider.calls.find(call => call.request.system.includes("calibrate pull-request findings"))
  assert.ok(audit)
  assert.deepEqual(audit.request.tools, [])
  assert.deepEqual(audit.request.mcpServers, [])
  assert.match(audit.request.prompt, /staged_findings/u)
  assert.match(audit.request.prompt, /Reject stale state/u)
  assert.doesNotMatch(audit.request.prompt, /lane_assessments/u)
  assert.doesNotMatch(audit.request.prompt, /\.singular-code-review\/pr\.diff/u)

  const synthesis = provider.calls.find(call => call.request.system.includes("concise pull-request review summary"))
  assert.ok(synthesis)
  assert.deepEqual(synthesis.request.tools, [])
  assert.match(synthesis.request.prompt, /lane_assessments/u)
  assert.match(synthesis.request.prompt, /retained_findings/u)
  assert.match(synthesis.request.prompt, /inline_comments/u)
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
          structured: { direct_answer: null, summary: "The focused change is ready.", recommendation: null }
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
  const provider = reviewProvider({ auditFindings: [], laneInputs: {} })
  const result = await runReview(reviewOptions(t, github.client), () => provider)

  assert.equal(provider.calls.filter(call => Boolean(laneName(call.request.prompt))).length, 6)
  assert.equal(result.lanes.length, 6)
  assert.match(result.body, /✅ LGTM$/u)
})

test("review Tools validate anchors, preserve cross-lane agreement, and coalesce one lane's retry", async () => {
  const reviews = new ReviewFindings(validationContext())
  const bugHunter = createReviewTools(reviews, "code-path-bug-hunter")
  const correctness = createReviewTools(reviews, "correctness-risk-testing")
  const context = { signal: new AbortController().signal }
  const input = commentInput(finding)

  assert.equal(bugHunter.addReviewComment.inputSchema.type, "object")
  assert.equal(Object.hasOwn(bugHunter.addReviewComment.inputSchema, "oneOf"), false)
  assert.equal(Object.hasOwn(bugHunter.addReviewComment.inputSchema, "anyOf"), false)
  await assert.rejects(
    bugHunter.addReviewComment.execute({ ...input, path: "src/not-changed.ts" }, context),
    /cannot queue review comment: path is not present in the PR diff/u
  )
  assert.equal((await bugHunter.addReviewComment.execute(input, context)).status, "queued")
  assert.equal((await bugHunter.addReviewComment.execute(input, context)).status, "already_queued")
  assert.equal((await correctness.addReviewComment.execute(input, context)).status, "queued")
  assert.equal(reviews.staged().length, 2)
})

test("review Tools keep inline suggestions and thread replies in one findings owner", async () => {
  const reviews = new ReviewFindings(validationContext())
  const tools = createReviewTools(reviews, "code-path-bug-hunter")
  const context = { signal: new AbortController().signal }

  await tools.addReviewComment.execute(
    {
      kind: "suggestion",
      severity: "high",
      title: "Keep the freshness guard enabled",
      message: "This assignment disables the guard for every response.",
      replacement: "const changed = false",
      evidence: "The added assignment is read by the response guard.",
      confidence: "high",
      path: "src/example.ts",
      line: 12
    },
    context
  )
  await tools.addReviewReply.execute(
    {
      severity: "low",
      title: "The prior finding still applies",
      body: "The new guard leaves the stale-state path reachable.",
      evidence: "The changed branch does not cover the prior top-level concern.",
      confidence: "high",
      to: 123
    },
    context
  )

  const staged = reviews.staged().map(item => item.finding)
  assert.equal(staged[0].kind, "inline")
  assert.equal(staged[0].comment_type, "suggestion")
  assert.match(staged[0].body, /```suggestion\nconst changed = false\n```/u)
  assert.equal(staged[1].kind, "reply")
  assert.equal(staged[1].to, 123)
})

test("review blocker Tool fixes critical severity and remains separate from inline publication", async t => {
  const blocker = {
    kind: "blocker",
    severity: "critical",
    title: "Do not publish the unsafe contract",
    body: "The proposed contract cannot safely land until the incompatible behavior is removed.",
    evidence: "The PR-level contract requires mutually incompatible behavior across every changed package.",
    confidence: "high"
  }
  const github = fakeGitHub()
  const provider = reviewProvider({
    auditFindings: [blocker, finding],
    laneInputs: {
      "standards-architecture": [blocker],
      "code-path-bug-hunter": [commentInput(finding)]
    },
    synthesis: {
      direct_answer: null,
      summary: "The implementation contains useful work, but the retained critical contract conflict prevents landing.",
      recommendation: "Resolve the remaining inline correctness issue as part of the safe redesign."
    }
  })
  const result = await runReview(reviewOptions(t, github.client), () => provider)

  assert.equal(result.audit.findings[0].kind, "blocker")
  assert.equal(result.audit.findings[0].severity, "critical")
  assert.equal(result.validated.inlineComments.length, 1)
  assert.match(result.body, /## Recommendations\n\n- \*\*Do not publish the unsafe contract:\*\*/u)
  assert.match(result.body, /Resolve the remaining inline correctness issue/u)
  assert.match(result.body, /## Verdict\n\n⛔ Block$/u)

  const tools = createReviewTools(new ReviewFindings(validationContext()), "standards-architecture")
  assert.deepEqual(Object.keys(tools.addReviewBlocker.inputSchema.properties).sort(), ["body", "evidence", "title"])
  assert.equal(tools.addReviewBlocker.inputSchema.additionalProperties, false)
})

test("audit cannot manufacture or promote an unstaged review blocker", async t => {
  const github = fakeGitHub()
  const fabricated = {
    kind: "blocker",
    severity: "critical",
    title: "Invented hard stop",
    body: "This blocker was never staged by a specialist.",
    evidence: "The audit attempted to create new evidence.",
    confidence: "high"
  }
  const provider = reviewProvider({ auditFindings: [fabricated] })

  await assert.rejects(
    runReview(reviewOptions(t, github.client), () => provider),
    /review audit returned a blocker that no specialist staged exactly/u
  )
  assert.equal(
    provider.calls.some(call => call.request.system.includes("concise pull-request review summary")),
    false
  )
  assert.deepEqual(github.writes, [])
})

test("audit cannot invent an unstaged inline target", async t => {
  const github = fakeGitHub()
  const provider = reviewProvider({
    auditFindings: [{ ...finding, line: 14 }]
  })

  await assert.rejects(
    runReview(reviewOptions(t, github.client), () => provider),
    /review audit returned an inline finding that no specialist staged at that target/u
  )
  assert.deepEqual(github.writes, [])
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
    auditFindings: [],
    laneInputs: {},
    synthesis: {
      direct_answer: null,
      summary: "The focused change preserves the existing behavior and is ready.",
      recommendation: null
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
  assert.equal(result.validated.inlineComments.length, 0)
})

test("lane terminal prose is never promoted into the canonical findings queue", async t => {
  const github = fakeGitHub()
  const provider = reviewProvider({
    auditFindings: [],
    laneInputs: {},
    laneSummaries: {
      "code-path-bug-hunter": "A possible regression was observed but was not staged through a review Tool."
    },
    synthesis: {
      direct_answer: null,
      summary: "No author-visible finding was staged for this review.",
      recommendation: null
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
  const hint = { ...finding, severity: "hint", title: "Clarify the active contract" }
  const critical = { ...finding, severity: "critical", title: "Prevent cross-tenant disclosure" }

  for (const [retained, expected] of [
    [hint, "✅ LGTM"],
    [critical, "⛔ Block"]
  ]) {
    const github = fakeGitHub()
    const provider = reviewProvider({
      auditFindings: [retained],
      laneInputs: { "code-path-bug-hunter": [commentInput(retained)] },
      synthesis: { direct_answer: null, summary: "The model does not choose the verdict.", recommendation: null }
    })
    const result = await runReview(reviewOptions(t, github.client), () => provider)
    assert.equal(result.body.endsWith(expected), true)
  }
})

test("deterministic validation drops an existing bot finding before deriving the verdict", async t => {
  const body = "**high:** Reject stale state\n\nThis branch accepts stale state and returns the wrong result."
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
      recommendation: null
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
    auditFindings: [],
    laneInputs: {},
    synthesis: {
      direct_answer: "@author Yes. The reviewed path still blocks stale responses.",
      summary: "The focused change preserves the stale-response guard and is ready.",
      recommendation: null
    }
  })

  const result = await runReview(options, () => provider)
  assert.match(
    result.body,
    /^> reviewer · deepseek-v4-flash\n\n@author Yes\. The reviewed path still blocks stale responses\.\n\n## Review Summary/u
  )
  const synthesis = provider.calls.find(call => call.request.system.includes("concise pull-request review summary"))
  assert.match(synthesis.request.prompt, /"participants": \[\n\s+"<@author>"/u)
  assert.match(synthesis.request.prompt, /please review this and tell me whether stale responses stay blocked/u)
})

test("thread-only reply requests cannot leak into the top-level review body", async t => {
  const github = fakeGitHub({
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
    auditFindings: [],
    laneInputs: {},
    synthesis: {
      direct_answer: "@author Yes. The latest push resolves the thread.",
      summary: "The focused change preserves the stale-response guard and is ready.",
      recommendation: null
    }
  })

  const result = await runReview(reviewOptions(t, github.client), () => provider)
  assert.doesNotMatch(result.body, /latest push resolves the thread/u)
  assert.match(result.body, /^> reviewer · deepseek-v4-flash\n\n## Review Summary/u)

  const synthesis = provider.calls.find(call => call.request.system.includes("concise pull-request review summary"))
  assert.match(synthesis.request.prompt, /"top_level_action_items": \[\]/u)
  assert.doesNotMatch(synthesis.request.prompt, /Does the latest push resolve this\?/u)
})

function validationContext() {
  return {
    generated_at: "2026-08-29T12:00:00Z",
    run: { bot_login: "singular-code-review[bot]" },
    diff: {
      file: ".singular-code-review/pr.diff",
      files: ["src/example.ts"],
      ignored: [],
      ranges: {
        "src/example.ts": {
          added_lines: [12],
          deleted_lines: [],
          left_lines: [10, 11],
          right_lines: [10, 11, 12]
        }
      }
    },
    review_threads_available: false,
    unresolved_bot_threads: [],
    review_comments: [
      {
        id: 123,
        in_reply_to_id: null,
        user_login: "author",
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
