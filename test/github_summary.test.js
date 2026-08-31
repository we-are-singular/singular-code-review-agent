import assert from "node:assert/strict"
import test from "node:test"

import { renderGitHubStepSummary } from "../dist/lib/github-summary.js"

function result(overrides = {}) {
  return {
    status: "reviewed",
    gate: { decision: "review", reason: "requested", source: "deterministic" },
    lanes: [],
    audit: { findings: [] },
    validated: {
      version: 1,
      inlineComments: [{ path: "src/index.ts", line: 2, side: "RIGHT", kind: "comment", body: "Fix this." }],
      replies: [{ to: 12, body: "Resolved." }],
      dropped: [{ kind: "inline", item: {}, reason: "duplicate" }],
      stats: {},
      conclusion: "Ready."
    },
    body: "Ready.",
    payload: { event: "COMMENT", body: "Ready.", comments: [] },
    generatedAt: "2026-08-31T10:00:00.000Z",
    repository: "owner/repository",
    prNumber: 42,
    provider: "codex",
    model: "gpt/luna",
    durationMs: 12_345,
    attempts: [],
    usage: {
      agentCalls: 9,
      inputTokens: 1_000,
      outputTokens: 200,
      reasoningTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: null,
      totalTokens: 1_250,
      costUsd: 0.0123
    },
    traceSummaries: [
      {
        runId: "hidden-run-id",
        status: "ok",
        durationMs: 12_000,
        agents: { sessions: { count: 9 }, turns: { count: 9 } },
        tools: { count: 3 },
        acpToolCalls: { count: 4, byName: {} },
        applicationSpans: {},
        cleanup: [],
        providerUsage: [],
        resources: {}
      }
    ],
    providerCompletions: [],
    publication: [{ status: "submitted" }, { status: "skipped" }],
    publicationStatus: "completed",
    publicationError: null,
    ...overrides
  }
}

test("GitHub summary reports the typed review result without trace identities", () => {
  const summary = renderGitHubStepSummary(result())

  assert.match(summary, /\| Model \| gpt\/luna \|/u)
  assert.match(summary, /\| Agent turns \| 9 \|/u)
  assert.match(summary, /\| Total tokens \| 1,250 \|/u)
  assert.match(summary, /\| Publication \| completed \(1 submitted operations\) \|/u)
  assert.match(summary, /\| 1 \| ok \| 12\.0 s \| 9 \| 9 \| 3 \| 4 \|/u)
  assert.doesNotMatch(summary, /hidden-run-id/u)
})

test("GitHub summary preserves unavailable provider usage as n/a", () => {
  const summary = renderGitHubStepSummary(
    result({
      usage: {
        agentCalls: 1,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: null,
        costUsd: null
      }
    })
  )

  assert.match(summary, /\| Input tokens \| n\/a \|/u)
  assert.match(summary, /\| Reported cost \| n\/a \|/u)
})
