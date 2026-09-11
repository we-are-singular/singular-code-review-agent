import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ReviewTelemetryCollector } from "../dist/lib/review-telemetry.js"
import { renderGitHubStepSummary } from "../dist/lib/render/github-summary.js"
import { writeReviewArtifacts } from "../eval/lib/review-artifacts.mjs"
import { buildEvalSummary } from "../eval/lib/analysis.mjs"
import { priceUsage } from "../eval/lib/pricing.mjs"
import modelPrices from "../dist/model-prices.json" with { type: "json" }

// npm test currently discovers root tests only. Include the related existing suites.
import "./review/telemetry.test.js"
import "./github/github_summary.test.js"
import "./eval/pricing.test.js"

const model = "opencode-go/minimax-m3"
// OpenCode omits zero cache-write usage and separates reasoning from output.
const tokens = { inputTokens: 200, outputTokens: 160, thoughtTokens: 40, cachedReadTokens: 2000, totalTokens: 2400 }

function collect(samples, selectedModel = model) {
  const telemetry = new ReviewTelemetryCollector()
  samples.forEach((usage, index) => {
    const common = {
      runId: "fixture",
      spanId: `turn-${index}`,
      timestamp: 1,
      sequence: index + 1,
      attributes: usage ? { usage: JSON.stringify(usage) } : {}
    }
    telemetry.trace({ ...common, type: "event", name: "acp.session.prompt.completed" })
    telemetry.trace({ ...common, type: "span.end", kind: "agent", name: "agent.turn", status: "ok", durationMs: 1 })
  })
  telemetry.trace({
    runId: "fixture",
    spanId: "root",
    timestamp: 2,
    sequence: samples.length + 1,
    attributes: {},
    type: "span.end",
    kind: "evaluation",
    name: "evaluation",
    status: "ok",
    durationMs: 2
  })
  return telemetry.usage(selectedModel)
}

function result(usage) {
  return {
    status: "no-review",
    gate: { decision: "no-review", reason: "fixture", source: "deterministic" },
    body: "Ready.",
    generatedAt: "2026-09-11T12:00:00Z",
    repository: "owner/repo",
    prNumber: 1,
    provider: "opencode",
    model,
    attempts: [],
    durationMs: 2,
    usage,
    traceSummaries: [],
    providerCompletions: [],
    publication: [],
    publicationStatus: "completed",
    publicationError: null
  }
}

test("real OpenCode-shaped ACP usage produces an estimate without inventing reported cost", () => {
  const usage = collect([tokens, tokens])
  assert.equal(usage.agentCalls, 2)
  assert.equal(usage.totalTokens, 4800)
  assert.equal(usage.cacheReadTokens, 4000)
  assert.equal(usage.costUsd, null)
  assert.ok(Math.abs(usage.estimatedCostUsd - 0.00084) < 1e-12)
  const summary = renderGitHubStepSummary(result(usage))
  assert.match(summary, /\| Estimated cost \| \$0\.0008 \|/u)
  assert.match(summary, /may omit intermediate model calls/u)
  assert.doesNotMatch(summary, /Provider-reported cost/u)
})

test("explicit reported zero and positive costs take precedence over estimates", () => {
  for (const costUsd of [0, 0.1234]) {
    const usage = collect([{ ...tokens, costUsd }])
    assert.equal(usage.costUsd, costUsd)
    assert.match(renderGitHubStepSummary(result(usage)), /\| Provider-reported cost \|/u)
    assert.equal(priceUsage({ model, usage, reportedCostUsd: costUsd }).source, "provider")
  }
})

test("a partial reported subtotal is not the full review cost", () => {
  const usage = collect([{ ...tokens, costUsd: 0.1 }, tokens])
  assert.equal(usage.costUsd, null)
  assert.ok(usage.estimatedCostUsd > 0)
})

test("unknown models, missing turns and invalid counters do not become free estimates", () => {
  assert.equal(collect([tokens], "unknown/model").estimatedCostUsd, null)
  assert.equal(collect([tokens], "toString").estimatedCostUsd, null)
  assert.equal(collect([]).estimatedCostUsd, null)
  assert.equal(collect([tokens, null]).estimatedCostUsd, null)
  for (const sample of [
    { ...tokens, inputTokens: null },
    { ...tokens, outputTokens: -1 },
    { ...tokens, cachedReadTokens: "2000" }
  ]) {
    assert.equal(collect([sample]).estimatedCostUsd, null)
  }
})

test("DeepSeek Flash and its versioned name use the same fixed maximum rates", () => {
  const alias = collect([tokens], "opencode-go/deepseek-flash")
  const versioned = collect([tokens], "opencode-go/deepseek-v4.1-flash")
  assert.equal(alias.estimatedCostUsd, versioned.estimatedCostUsd)
  assert.ok(Math.abs(alias.estimatedCostUsd - 0.000312) < 1e-12)
  assert.equal(priceUsage({ model: "opencode-go/deepseek-flash", usage: alias }).costUsd, alias.estimatedCostUsd)
})

test("tuple arithmetic includes cache writes and separate reasoning exactly once", t => {
  modelPrices["fixture/model"] = [1, 2, 3, 4]
  t.after(() => delete modelPrices["fixture/model"])
  const usage = collect(
    [
      {
        inputTokens: 1000000,
        outputTokens: 2000000,
        thoughtTokens: 1000000,
        cachedReadTokens: 3000000,
        cachedWriteTokens: 4000000
      }
    ],
    "fixture/model"
  )
  assert.equal(usage.estimatedCostUsd, 32)
})

test("two-value free-model tuples default both cache rates to zero", () => {
  const freeModel = "opencode-go/ox-alpha-free"
  const usage = collect([tokens], freeModel)
  assert.equal(usage.estimatedCostUsd, 0)
  assert.equal(priceUsage({ model: freeModel, usage }).costUsd, 0)
})

test("eval exports and analysis preserve missing reported cost and use the same fixed map", t => {
  const directory = mkdtempSync(join(tmpdir(), "review-cost-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const usage = collect([tokens])
  const exported = writeReviewArtifacts(result(usage), directory, "2026-09-11T12:00:00Z")
  const stats = JSON.parse(readFileSync(exported.paths.stats, "utf8"))
  assert.equal(stats.totals.costUsd, null)
  assert.equal(stats.totals.estimatedCostUsd, usage.estimatedCostUsd)
  const summary = buildEvalSummary({
    runDir: directory,
    run: {
      status: "completed",
      jobs: [{ model, status: "completed", input: { slug: "fixture", ref: "owner/repo#1" }, files: exported.paths }]
    },
    judgments: []
  })
  assert.equal(summary.results[0].captureUsage.costUsd, null)
  assert.ok(Math.abs(summary.results[0].costUsd - usage.estimatedCostUsd) < 1e-12)
  assert.equal(summary.results[0].costSource, "price-table")
})
