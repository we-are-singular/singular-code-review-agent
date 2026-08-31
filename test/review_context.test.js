import assert from "node:assert/strict"
import test from "node:test"

import { AmlRuntime } from "@aml-jsx/sdk"
import { jsx } from "@aml-jsx/sdk/jsx-runtime"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

import { ReviewContext, ReviewOutcome, useReviewContext } from "../dist/components/review-context.js"

function runtime() {
  return new AmlRuntime({
    agentProvider: new DeterministicAgentProvider(),
    maxConcurrentAgents: 2
  })
}

function reviewValue(id) {
  const service = { id }
  return {
    github: service,
    actions: service,
    queue: service,
    outcome: new ReviewOutcome(),
    snapshot: { id },
    model: id,
    gate: { decision: "review", reason: id, source: "deterministic" }
  }
}

function ReadReview() {
  const review = useReviewContext()
  return JSON.stringify({
    github: review.github.id,
    model: review.model,
    gate: review.gate
  })
}

function RecordGateResult() {
  const review = useReviewContext()
  review.gate = { decision: "no-review", answer: "No review needed.", source: "deterministic" }
  return ""
}

function provided(value, children) {
  return jsx(ReviewContext.Provider, { value, children })
}

test("nested Context Providers preserve the flat request-scoped review context", async () => {
  const initial = reviewValue("request-1")
  const gate = { decision: "no-review", answer: "Nested route.", source: "deterministic" }
  const value = await runtime().evaluate(provided(initial, provided({ ...initial, gate }, jsx(ReadReview, {}))))

  assert.deepEqual(JSON.parse(value), {
    github: "request-1",
    model: "request-1",
    gate
  })
})

test("simultaneous evaluations isolate review context values", async () => {
  const [first, second] = await Promise.all([
    runtime().evaluate(provided(reviewValue("first"), jsx(ReadReview, {}))),
    runtime().evaluate(provided(reviewValue("second"), jsx(ReadReview, {})))
  ])

  assert.equal(JSON.parse(first).github, "first")
  assert.equal(JSON.parse(second).github, "second")
})

test("authored routers share their gate decision through the request-scoped Context", async () => {
  const initial = reviewValue("request-1")
  const value = await runtime().evaluate(provided(initial, [jsx(RecordGateResult, {}), jsx(ReadReview, {})]))

  assert.deepEqual(JSON.parse(value), {
    github: "request-1",
    model: "request-1",
    gate: { decision: "no-review", answer: "No review needed.", source: "deterministic" }
  })
})

test("ReviewOutcome publishes exactly once", () => {
  const outcome = new ReviewOutcome()
  const draft = {
    status: "no-review",
    gate: { decision: "no-review", answer: "Already reviewed.", source: "deterministic" },
    body: "Already reviewed.\n\n✅ LGTM"
  }

  assert.throws(() => outcome.result(), /without a publication outcome/u)

  outcome.publish(draft, null)
  assert.deepEqual(outcome.result(), { review: draft, publicationError: null })
  assert.throws(() => outcome.publish(draft, null), /already complete/u)
})
