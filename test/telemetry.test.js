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

test("review telemetry renders only review components and completed turn text", () => {
  const lines = []
  const telemetry = new ReviewTelemetryCollector({ progress: line => lines.push(line) })
  telemetry.trace(spanStart("hidden-run", { kind: "evaluation", name: "evaluation", spanId: "root" }))
  telemetry.trace(
    spanStart("hidden-run", {
      kind: "component",
      name: "ReviewAudit",
      spanId: "audit",
      parentSpanId: "root"
    })
  )
  telemetry.trace(
    spanStart("hidden-run", {
      kind: "component",
      name: "Block",
      spanId: "block",
      parentSpanId: "audit"
    })
  )
  telemetry.trace(
    spanStart("hidden-run", {
      kind: "agent",
      name: "agent.session",
      spanId: "agent",
      parentSpanId: "audit",
      attributes: { name: "code-path-bug-hunter", provider: "codex" }
    })
  )
  telemetry.trace(
    spanStart("hidden-run", {
      kind: "agent",
      name: "agent.turn",
      spanId: "turn",
      parentSpanId: "agent",
      attributes: { index: 1, kind: "initial", prompt: "hidden prompt" }
    })
  )
  telemetry.trace({
    ...event("hidden-run", "acp.session.update", {
      sessionId: "hidden-session",
      sessionUpdate: "agent_message_chunk",
      update: JSON.stringify({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Useful lane result." }
      })
    }),
    spanId: "turn"
  })
  telemetry.trace(
    spanEnd("hidden-run", {
      kind: "agent",
      name: "agent.turn",
      spanId: "turn",
      parentSpanId: "agent",
      attributes: { usage: "hidden usage" }
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
  telemetry.trace(spanEnd("hidden-run", { kind: "component", name: "Block", spanId: "block", parentSpanId: "audit" }))
  telemetry.trace(
    spanEnd("hidden-run", { kind: "component", name: "ReviewAudit", spanId: "audit", parentSpanId: "root" })
  )
  telemetry.trace(spanEnd("hidden-run", { kind: "evaluation", name: "evaluation", spanId: "root" }))

  assert.equal(telemetry.trace.captureContent, true)
  assert.match(lines.join("\n"), /▶ component ReviewAudit/u)
  assert.match(lines.join("\n"), /▶ turn code-path-bug-hunter #1/u)
  assert.match(lines.join("\n"), /✓ turn code-path-bug-hunter #1 10ms/u)
  assert.match(lines.join("\n"), /│ Useful lane result\./u)
  assert.match(lines.join("\n"), /✓ component ReviewAudit 10ms/u)
  assert.doesNotMatch(lines.join("\n"), /Block|agent\.session|hidden-run|hidden-session|hidden prompt|hidden usage/u)
  assert.doesNotMatch(JSON.stringify(telemetry.summaries()), /Useful lane result\./u)
})

test("review telemetry stays content-free without progress output", () => {
  const telemetry = new ReviewTelemetryCollector()

  assert.equal(telemetry.trace.captureContent, false)
})
