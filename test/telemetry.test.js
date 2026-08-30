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

function event(runId, name, attributes) {
  return {
    type: "event",
    runId,
    spanId: "agent-turn",
    sequence: 1,
    timestamp: Date.now(),
    name,
    attributes
  }
}

test("review telemetry derives usage and summaries from completed AML evaluations", () => {
  const telemetry = new ReviewTelemetryCollector()
  const runId = "review-run"
  telemetry.trace(
    event(runId, "acp.session.prompt.completed", {
      sessionId: "session-1",
      stopReason: "end_turn",
      usage: JSON.stringify({ totalTokens: 208 })
    })
  )
  telemetry.trace(
    spanEnd(runId, {
      kind: "agent",
      name: "agent.turn",
      attributes: {
        usage: JSON.stringify({
          inputTokens: 100,
          outputTokens: 20,
          thoughtTokens: 8,
          cachedReadTokens: 80,
          cachedWriteTokens: 5,
          totalTokens: 208,
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
    cacheReadTokens: 80,
    cacheWriteTokens: 5,
    totalTokens: 208,
    costUsd: 0.01
  })
  assert.equal(telemetry.summaries().length, 1)
  assert.equal(telemetry.summaries()[0].applicationSpans["review.audit"].totalDurationMs, 7)
  assert.deepEqual(telemetry.providerCompletions(), [
    {
      runId,
      sessionId: "session-1",
      stopReason: "end_turn"
    }
  ])
})

test("review telemetry ignores incomplete provider completion events", () => {
  const telemetry = new ReviewTelemetryCollector()
  telemetry.trace(event("review-run", "acp.session.prompt.completed", { sessionId: "session-1" }))
  telemetry.trace(event("review-run", "unrelated", { sessionId: "session-2", stopReason: "end_turn" }))

  assert.deepEqual(telemetry.providerCompletions(), [])
})
