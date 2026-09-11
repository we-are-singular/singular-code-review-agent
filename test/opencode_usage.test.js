import assert from "node:assert/strict"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"

import { OpenCodeUsage } from "../dist/lib/opencode-usage.js"
import { renderGitHubStepSummary } from "../dist/lib/render/github-summary.js"
import { writeReviewArtifacts } from "../eval/lib/review-artifacts.mjs"
import { buildEvalSummary } from "../eval/lib/analysis.mjs"

const amlUsage = {
  agentCalls: 1,
  inputTokens: 200,
  outputTokens: 160,
  reasoningTokens: 40,
  cacheReadTokens: 2000,
  cacheWriteTokens: null,
  totalTokens: 2400,
  costUsd: null,
  estimatedCostUsd: 0.00042
}
const tokens = { input: 100, output: 80, reasoning: 20, cache: { read: 1000, write: 0 }, total: 1200 }

function collector(t) {
  const usage = new OpenCodeUsage()
  assert.ok(usage.directory)
  t.after(() => usage.close())
  return usage
}

function database(usage, name, steps) {
  const path = join(usage.directory, `aml-acp-${name}.db`)
  const db = new DatabaseSync(path)
  db.exec(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT)"
  )
  for (const [index, step] of steps.entries()) {
    const session = step.session ?? "session-1"
    const message = step.message ?? `message-${index}`
    // Two steps may share one message. Its last usage and cost are deliberately
    // bogus: the collector must use step parts, never add message totals to them.
    db.prepare("INSERT OR REPLACE INTO message VALUES (?, ?, ?)").run(
      message,
      session,
      JSON.stringify({
        role: "assistant",
        providerID: step.provider ?? "opencode-go",
        modelID: step.model ?? "minimax-m3",
        tokens: { ...tokens, total: 999999 },
        cost: 999
      })
    )
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(
      `part-${index}`,
      message,
      session,
      JSON.stringify({
        type: step.type ?? "step-finish",
        tokens: step.tokens ?? tokens,
        cost: 999
      })
    )
  }
  db.close()
  return path
}

test("stored steps override AML exactly once, retaining original counters and authored turn count", t => {
  const usage = collector(t)
  database(usage, "one", [
    { message: "same" },
    {
      message: "same",
      tokens: { input: 200, output: 160, reasoning: 40, cache: { read: 2000, write: 0 }, total: 2400 }
    },
    { type: "step-start" }
  ])
  usage.collect(["session-1"])
  usage.collect(["session-1"])
  const result = usage.apply(amlUsage)
  assert.equal(result.usageSource, "opencode-db")
  assert.deepEqual(result.amlUsage, amlUsage)
  assert.equal(result.usage.agentCalls, 1)
  assert.equal(result.usage.totalTokens, 3600)
  assert.equal(result.usage.outputTokens, 240)
  assert.equal(result.usage.reasoningTokens, 60)
  assert.equal(result.usage.cacheReadTokens, 3000)
  assert.equal(result.usage.costUsd, null)
  assert.ok(Math.abs(result.usage.estimatedCostUsd - 0.00063) < 1e-12)
  assert.match(result.usageNote, /2 stored model steps/u)
  usage.close()
  assert.equal(existsSync(usage.directory), false)
  assert.deepEqual(usage.apply(amlUsage), result)
})

test("separate session databases price actual models, including cache and reasoning", t => {
  const usage = collector(t)
  database(usage, "one", [{ session: "one", model: "minimax-m3" }])
  database(usage, "two", [{ session: "two", model: "deepseek-flash" }])
  usage.collect(["one", "two"])
  const result = usage.apply(amlUsage)
  assert.equal(result.usageSource, "opencode-db")
  assert.equal(result.usage.totalTokens, 2400)
  assert.ok(Math.abs(result.usage.estimatedCostUsd - (0.00021 + 0.000156)) < 1e-12)
})

test("unknown model preserves recovered tokens but does not produce a partial price", t => {
  const usage = collector(t)
  database(usage, "one", [{}, { model: "unknown" }])
  usage.collect(["session-1"])
  assert.equal(usage.apply(amlUsage).usageSource, "opencode-db")
  assert.equal(usage.apply(amlUsage).usage.totalTokens, 2400)
  assert.equal(usage.apply(amlUsage).usage.estimatedCostUsd, null)
})

test("optional total uses disjoint counters, including cache writes; free rates remain explicit zero", t => {
  const usage = collector(t)
  database(usage, "one", [
    { model: "ox-alpha-free", tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 100, write: 15 } } }
  ])
  usage.collect(["session-1"])
  assert.equal(usage.apply(amlUsage).usage.totalTokens, 150)
  assert.equal(usage.apply(amlUsage).usage.cacheWriteTokens, 15)
  assert.equal(usage.apply(amlUsage).usage.estimatedCostUsd, 0)
})

test("missing sessions, corrupt databases and invalid counters fall back without mixing subtotals", t => {
  for (const scenario of ["missing-session", "corrupt", "invalid", "no-sessions"]) {
    const usage = collector(t)
    database(usage, "good", [{}])
    if (scenario === "corrupt") writeFileSync(join(usage.directory, "aml-acp-corrupt.db"), "not sqlite")
    if (scenario === "invalid") database(usage, "bad", [{ tokens: { ...tokens, input: -1 } }])
    usage.collect(
      scenario === "no-sessions" ? [] : scenario === "missing-session" ? ["session-1", "missing"] : ["session-1"]
    )
    const result = usage.apply(amlUsage)
    assert.equal(result.usageSource, "aml-acp", scenario)
    assert.deepEqual(result.usage, amlUsage, scenario)
    assert.match(result.usageNote, /using AML counters/u)
  }
})

test("run-owned directories prevent usage leaking between concurrent reviews", t => {
  const first = collector(t)
  const second = collector(t)
  database(first, "one", [{}])
  database(second, "two", [{}, {}])
  first.collect(["session-1"])
  second.collect(["session-1"])
  assert.equal(first.apply(amlUsage).usage.totalTokens, 1200)
  assert.equal(second.apply(amlUsage).usage.totalTokens, 2400)
})

test("summary and eval retain source, AML evidence and per-model DB estimate", t => {
  for (const model of ["deepseek-flash", "unknown"]) {
    const usage = collector(t)
    database(usage, "one", [{}, { model }])
    usage.collect(["session-1"])
    const result = {
      status: "no-review",
      gate: { decision: "no-review", reason: "fixture", source: "deterministic" },
      body: "Ready.",
      generatedAt: "2026-09-11T12:00:00Z",
      repository: "owner/repo",
      prNumber: 1,
      provider: "opencode",
      model: "opencode-go/minimax-m3",
      attempts: [],
      durationMs: 2,
      ...usage.apply(amlUsage),
      traceSummaries: [],
      providerCompletions: [],
      publication: [],
      publicationStatus: "completed",
      publicationError: null
    }
    const summary = renderGitHubStepSummary(result)
    assert.match(summary, /Usage source \| opencode-db/u)
    assert.match(summary, /AML counters retained separately/u)
    const exported = writeReviewArtifacts(result, usage.directory, result.generatedAt)
    const report = buildEvalSummary({
      runDir: usage.directory,
      run: {
        status: "completed",
        jobs: [
          {
            model: result.model,
            status: "completed",
            input: { slug: "fixture", ref: "owner/repo#1" },
            files: exported.paths
          }
        ]
      },
      judgments: []
    })
    assert.equal(report.results[0].costUsd, result.usage.estimatedCostUsd)
  }
})
