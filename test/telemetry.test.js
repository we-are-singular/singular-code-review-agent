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

function spanStart(runId, overrides) {
  return {
    type: "span.start",
    runId,
    spanId: `${overrides.kind}-${overrides.name}`,
    sequence: 1,
    timestamp: Date.now(),
    attributes: {},
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

test("review telemetry renders nested lifecycle progress without identities or content", () => {
  const lines = []
  const telemetry = new ReviewTelemetryCollector({ progress: line => lines.push(line) })
  telemetry.trace(spanStart("hidden-run", { kind: "evaluation", name: "evaluation", spanId: "root" }))
  telemetry.trace(
    spanStart("hidden-run", {
      kind: "agent",
      name: "agent.session",
      spanId: "agent",
      parentSpanId: "root",
      attributes: { name: "code-path-bug-hunter", provider: "codex" }
    })
  )
  telemetry.trace(
    event("hidden-run", "acp.session.update", {
      sessionId: "hidden-session",
      sessionUpdate: "agent_message_chunk",
      content: "hidden model output"
    })
  )
  telemetry.trace(
    spanEnd("hidden-run", {
      kind: "agent",
      name: "agent.session",
      spanId: "agent",
      parentSpanId: "root",
      attributes: { name: "code-path-bug-hunter", provider: "codex" }
    })
  )
  telemetry.trace(spanEnd("hidden-run", { kind: "evaluation", name: "evaluation", spanId: "root" }))

  assert.match(lines.join("\n"), /▶ agent\.session name="code-path-bug-hunter" provider="codex"/u)
  assert.match(lines.join("\n"), /✓ agent\.session 10ms/u)
  assert.doesNotMatch(lines.join("\n"), /hidden-run|hidden-session|hidden model output/u)
})
