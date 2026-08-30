import assert from "node:assert/strict"
import test from "node:test"

import { ReviewTelemetryCollector } from "../dist/lib/review-telemetry.js"

function spanEnd(runId, overrides) {
  return {
    type: "span.end",
    runId,
    spanId: `${overrides.kind}-${overrides.name}`,
    sequence: 1,
    timestamp: Date.now(),
    attributes: {},
    durationMs: 10,
    status: "ok",
    ...overrides
  }
}

test("review telemetry derives usage and summaries from completed AML evaluations", () => {
  const telemetry = new ReviewTelemetryCollector()
  const runId = "review-run"
  telemetry.trace(
    spanEnd(runId, {
      kind: "agent",
      name: "agent.turn",
      attributes: {
        usage: JSON.stringify({
          inputTokens: 100,
          outputTokens: 20,
          thoughtTokens: 8,
          totalTokens: 128,
          costUsd: 0.01
        })
      }
    })
  )
  telemetry.trace(spanEnd(runId, { kind: "application", name: "review.audit", durationMs: 7 }))
  telemetry.trace(spanEnd(runId, { kind: "evaluation", name: "evaluation", durationMs: 30 }))

  assert.deepEqual(telemetry.usage(), {
    agentCalls: 1,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 8,
    totalTokens: 128,
    costUsd: 0.01
  })
  assert.equal(telemetry.summaries().length, 1)
  assert.equal(telemetry.summaries()[0].applicationSpans["review.audit"].totalDurationMs, 7)
})
