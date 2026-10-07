import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

import { renderIssuesContext } from "../dist/lib/render/review-context.js"
import { runReview } from "../dist/run-review.js"
import { createGitHubClient, NotAnIssueError } from "../dist/services/github/client.js"
import { parseRelatedReferences } from "../dist/services/github/context-model.js"
import { GitHubReviewSession } from "../dist/services/github/session.js"
import { createGitHubReadTools } from "../dist/tools/github-read.js"

const repository = "owner/repository"
const updatedAt = "2026-10-07T12:00:00Z"
const head = "2".repeat(40)
const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1,2 @@
 export const stable = true
+export const changed = true
`

function mockGraphQL(t, result) {
  const requests = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init.body))
    requests.push(request)
    // GitHub throws before returning null when an issue-only query names a PR.
    const response = /\bissue\(number:/u.test(request.query)
      ? { errors: [{ message: "Could not resolve to an Issue with the number of 1875." }] }
      : result
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  }
  t.after(() => {
    globalThis.fetch = previousFetch
  })
  return { client: createGitHubClient({ token: "test-token", repository }), requests }
}

function fixture(body = "related to #1875, #17, #18, #1875, #42") {
  const pulls = new Map([
    [`${repository}#42`, { number: 42, title: "Active change", body, headRefOid: head, updatedAt }],
    [
      `${repository}#1875`,
      {
        number: 1875,
        title: "Earlier PR",
        body: "Related implementation decisions.\nrelated to #42, other/project#91",
        html_url: `https://github.com/${repository}/pull/1875`,
        state: "closed",
        headRefOid: "3".repeat(40),
        updatedAt
      }
    ]
  ])
  const issues = new Map(
    [17, 18].map(number => [
      `${repository}#${number}`,
      { repository, number, title: `Issue ${number}`, body: "Current requirements.", updated_at: updatedAt }
    ])
  )
  const calls = []
  const client = {
    async getPullRequest(number, target) {
      calls.push(["pull", target, number])
      const pullRequest = pulls.get(`${target}#${number}`)
      assert.ok(pullRequest, `Unexpected PR read: ${target}#${number}`)
      return { ...pullRequest }
    },
    async getPullRequestDiff() {
      return diff
    },
    async getIssueOrPullRequest(number, target) {
      calls.push(["reference", target, number])
      const key = `${target}#${number}`
      if (issues.has(key)) return { kind: "issue", issue: { ...issues.get(key) } }
      if (pulls.has(key)) return { kind: "pull_request", pullRequest: { ...pulls.get(key) } }
      throw new Error(`${key} is not accessible`)
    },
    async getIssue() {
      assert.fail("Related references must not use the literal issue read")
    },
    async listPullRequestClosingIssues(number) {
      return number === 42 ? [{ ...issues.get(`${repository}#18`) }] : []
    },
    async listPullRequestComments(number) {
      return [{ id: number, body: `Discussion for PR ${number}`, user: { login: "author" } }]
    },
    async listIssueComments() {
      return [{ id: 1, body: "Issue decision." }]
    },
    async listIssueTimeline() {
      return []
    },
    async listReviewComments(number) {
      return [{ id: number + 1, body: `Review comment for PR ${number}`, path: "src/example.ts", line: 2 }]
    },
    async listReviews(number) {
      return [{ id: number + 2, state: "APPROVED", body: `Review for PR ${number}` }]
    },
    async listPullRequestTimeline() {
      return [{ event: "merged", created_at: updatedAt }]
    },
    async listPullRequestCommits() {
      return [{ sha: head, commit: { message: "Earlier implementation", author: { date: updatedAt } } }]
    },
    async listReviewThreads() {
      return { available: false, threads: [] }
    }
  }
  const session = new GitHubReviewSession(client, {
    repository,
    prNumber: 42,
    workspace: "/tmp/review",
    workspaceHeadSha: head,
    botLogin: "review-bot",
    eventName: null,
    eventPath: null,
    actor: null,
    ignoreHistory: false
  })
  return { client, session, pulls, issues, calls }
}

test("GitHub resolves PR numbers through the union query and literal issue Tools still reject them", async t => {
  const { client, requests } = mockGraphQL(t, {
    data: {
      repository: {
        issueOrPullRequest: { __typename: "PullRequest", number: 1875, updatedAt, headRefOid: head }
      }
    }
  })

  const reference = await client.getIssueOrPullRequest(1875)
  assert.equal(reference.kind, "pull_request")
  assert.equal(reference.pullRequest.number, 1875)
  assert.equal(reference.pullRequest.updatedAt, updatedAt)
  assert.equal(reference.pullRequest.headRefOid, head)
  await assert.rejects(client.getIssue(1875), NotAnIssueError)
  assert.match(requests[0].query, /issueOrPullRequest\(number: \$number\)/u)
  assert.match(requests[0].query, /\.\.\. on Issue/u)
  assert.match(requests[0].query, /\.\.\. on PullRequest/u)
})

test("union issue reads retain current requirements and edit history", async t => {
  const { client } = mockGraphQL(t, {
    data: {
      repository: {
        issueOrPullRequest: {
          __typename: "Issue",
          number: 17,
          title: "Current contract",
          body: "Full requirements.",
          state: "OPEN",
          updatedAt,
          repository: { nameWithOwner: "other/project" },
          userContentEdits: { nodes: [{ editedAt: updatedAt, diff: "Requirement changed." }] }
        }
      }
    }
  })

  const reference = await client.getIssueOrPullRequest(17, "other/project")
  assert.equal(reference.kind, "issue")
  assert.equal(reference.issue.repository, "other/project")
  assert.equal(reference.issue.state, "open")
  assert.equal(reference.issue.body, "Full requirements.")
  assert.equal(reference.issue.updated_at, updatedAt)
  assert.equal(reference.issue.edits[0].diff, "Requirement changed.")
  assert.deepEqual(await client.getIssue(17, "other/project"), reference.issue)
})

test("missing references and API failures are not silently treated as PRs", async t => {
  const { client } = mockGraphQL(t, { data: { repository: { issueOrPullRequest: null } } })
  await assert.rejects(client.getIssueOrPullRequest(999), /not accessible/u)
  await assert.rejects(client.getIssue(999), error => !(error instanceof NotAnIssueError))
})

test("GitHub response errors remain visible rather than becoming reference type mismatches", async t => {
  const { client } = mockGraphQL(t, { errors: [{ message: "Resource not accessible by integration" }] })
  await assert.rejects(
    client.getIssueOrPullRequest(1875),
    error => !(error instanceof NotAnIssueError) && /Resource not accessible/u.test(error.message)
  )
})

test("related clauses accept numbered references and GitHub URLs without promoting incidental mentions", () => {
  assert.deepEqual(
    parseRelatedReferences(
      "Incidental #99.\nRelated to: #17, other/project#91, [#1875](https://github.com/linked/repo/pull/1875), https://github.com/other/project/issues/91. See #98.\nrelates to #17",
      repository
    ),
    [
      { repository, number: 17 },
      { repository: "other/project", number: 91 },
      { repository: "linked/repo", number: 1875 }
    ]
  )
})

test("snapshots retain mixed issue and PR context with one-hop PR history and cached Tool reads", async () => {
  const { session, calls } = fixture()
  const snapshot = await session.snapshot()
  assert.deepEqual(
    snapshot.context.issues.map(issue => [issue.number, issue.relation]),
    [
      [18, "closes"],
      [17, "related"]
    ]
  )
  assert.equal(snapshot.context.pullRequests.length, 1)
  const related = snapshot.context.pullRequests[0]
  assert.equal(related.kind, "pull_request")
  assert.equal(related.relation, "related")
  assert.equal(related.number, 1875)
  assert.match(related.description, /Related implementation decisions/u)
  assert.deepEqual(related.changedFiles, ["src/example.ts"])
  assert.ok(related.history.entries.some(entry => entry.body === "Discussion for PR 1875"))
  assert.ok(related.history.entries.some(entry => entry.body === "Review for PR 1875"))
  assert.ok(related.history.entries.some(entry => entry.body === "Review comment for PR 1875"))
  assert.equal(related.commits[0].subject, "Earlier implementation")
  assert.equal(
    calls.some(([, target, number]) => target === "other/project" && number === 91),
    false
  )
  assert.equal(
    calls.some(([kind, , number]) => kind === "reference" && number === 42),
    false
  )

  const tools = createGitHubReadTools(session)
  const serialized = await tools.getPullRequest.execute({ pull_number: 42 })
  assert.equal(serialized.pullRequests[0].number, 1875)
  assert.ok(serialized.pullRequests[0].history.entries.some(entry => entry.includes("Discussion for PR 1875")))
  assert.ok(serialized.pullRequests[0].commits[0].includes("Earlier implementation"))
  assert.deepEqual(
    calls.filter(([kind]) => kind === "pull").map(([, , number]) => number),
    [42, 1875]
  )

  const rendered = renderIssuesContext(snapshot)
  assert.match(rendered, /Earlier PR/u)
  assert.match(rendered, /Discussion for PR 1875/u)
  assert.match(rendered, /Review for PR 1875/u)
  assert.match(rendered, /src\/example\.ts/u)
  assert.match(rendered, /context only/u)
})

test("snapshot gathering loads PR 1875 through the live client's union resolver", async t => {
  const { session, client } = fixture("related to #1875")
  const { client: liveClient } = mockGraphQL(t, {
    data: {
      repository: {
        issueOrPullRequest: { __typename: "PullRequest", number: 1875, updatedAt, headRefOid: "3".repeat(40) }
      }
    }
  })
  client.getIssueOrPullRequest = liveClient.getIssueOrPullRequest
  const snapshot = await session.snapshot()
  assert.equal(snapshot.context.pullRequests[0].number, 1875)
  await session.assertReviewContextUnchanged()
})

test("a complete review gives every lane related PR history and passes publication checks", async t => {
  const { session, client } = fixture()
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "review-pr-reference-"))
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  const provider = new DeterministicAgentProvider({
    async respond(request) {
      if (request.system.includes("concise pull-request review summary")) {
        return {
          text: "",
          structured: {
            direct_answer: null,
            summary: "The change preserves the earlier PR's decisions.",
            recommendation: null
          }
        }
      }
      return { text: "Checked the change against the referenced PR; no finding remains." }
    }
  })
  const result = await runReview(
    {
      request: { ...session.request, workspace },
      github: client,
      actionMode: "dry-run",
      provider: "opencode",
      model: "opencode-go/deepseek-v4-flash",
      maximumConcurrency: 6
    },
    () => provider
  )
  assert.equal(result.status, "reviewed")
  assert.equal(result.publicationStatus, "completed")
  const lanes = provider.calls.filter(call => call.request.prompt.includes("## Your lane is"))
  assert.equal(lanes.length, 6)
  for (const lane of lanes) {
    assert.match(lane.request.prompt, /Earlier PR/u)
    assert.match(lane.request.prompt, /Discussion for PR 1875/u)
    assert.match(lane.request.prompt, /Current requirements/u)
    assert.match(lane.request.prompt, /context only/u)
  }
})

test("PR-only related context is rendered and cross-repository PR reads stay scoped", async () => {
  const { session, pulls, client } = fixture("related to https://github.com/other/project/pull/91")
  client.listPullRequestClosingIssues = async () => []
  const related = pulls.get(`${repository}#1875`)
  pulls.set("other/project#91", { ...related, number: 91 })
  const snapshot = await session.snapshot()
  assert.deepEqual(snapshot.context.issues, [])
  assert.equal(snapshot.context.pullRequests[0].repository, "other/project")
  assert.match(renderIssuesContext(snapshot), /other\/project#91/u)
  await session.assertReviewContextUnchanged()
})

test("freshness checks re-resolve both issues and PRs outside the snapshot cache", async () => {
  const { session, pulls } = fixture()
  await session.snapshot()
  await session.assertReviewContextUnchanged()

  const related = pulls.get(`${repository}#1875`)
  related.headRefOid = "4".repeat(40)
  await assert.rejects(session.assertReviewContextUnchanged(), /referenced.*changed/u)
  related.headRefOid = "3".repeat(40)
  related.updatedAt = "2026-10-07T12:01:00Z"
  await assert.rejects(session.assertReviewContextUnchanged(), /referenced.*changed/u)
})

test("many related PRs load and recheck with bounded concurrency without dropping evidence", async () => {
  const numbers = Array.from({ length: 10 }, (_, index) => 101 + index)
  const { session, client, pulls } = fixture(`related to ${numbers.map(number => `#${number}`).join(", ")}`)
  const earlier = pulls.get(`${repository}#1875`)
  for (const number of numbers) {
    pulls.set(`${repository}#${number}`, { ...earlier, number })
  }
  let active = 0
  let peak = 0
  const readPullRequest = client.getPullRequest
  client.getPullRequest = async (number, target) => {
    if (number === 42) return readPullRequest(number, target)
    active += 1
    peak = Math.max(peak, active)
    // Hold one endpoint open so the measurement includes PR expansion, rather
    // than only the preceding reference-type lookup.
    await new Promise(resolve => setImmediate(resolve))
    const result = await readPullRequest(number, target)
    active -= 1
    return result
  }
  const snapshot = await session.snapshot()
  assert.deepEqual(
    snapshot.context.pullRequests.map(pr => pr.number),
    numbers
  )
  assert.ok(peak > 1 && peak <= 4, `PR enrichment concurrency was ${peak}`)

  peak = 0
  const readReference = client.getIssueOrPullRequest
  client.getIssueOrPullRequest = async (number, target) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setImmediate(resolve))
    const result = await readReference(number, target)
    active -= 1
    return result
  }
  await session.assertReviewContextUnchanged()
  assert.ok(peak > 1 && peak <= 4, `Reference freshness concurrency was ${peak}`)
})

test("closing and related issue edits still invalidate publication", async () => {
  for (const number of [17, 18]) {
    const { session, issues } = fixture()
    await session.snapshot()
    issues.get(`${repository}#${number}`).updated_at = "2026-10-07T12:01:00Z"
    await assert.rejects(session.assertReviewContextUnchanged(), /referenced.*changed/u)
  }
})

test("referenced API failures propagate instead of dropping review evidence", async () => {
  const { session, client } = fixture()
  client.getIssueOrPullRequest = async () => {
    throw new Error("GitHub unavailable")
  }
  await assert.rejects(session.snapshot(), /GitHub unavailable/u)
})
