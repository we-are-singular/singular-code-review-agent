import assert from "node:assert/strict"
import test from "node:test"

import { AmlRuntime } from "@aml-jsx/sdk"
import { jsx } from "@aml-jsx/sdk/jsx-runtime"
import { DeterministicAgentProvider } from "@aml-jsx/sdk/testing"

import { ReviewContext, ReviewOutcome, useReview } from "../dist/aml/review-context.js"

function runtime() {
  return new AmlRuntime({
    agentProvider: new DeterministicAgentProvider(),
    maxConcurrentAgents: 2,
    maxTurnsPerAgent: 1
  })
}

function reviewValue(id) {
  const service = { id }
  return {
    github: service,
    actions: service,
    findings: service,
    outcome: new ReviewOutcome(),
    snapshot: { id },
    model: id,
    gate: { decision: "review", reason: id, source: "deterministic" }
  }
}

function ReadReview() {
  const review = useReview()
  return JSON.stringify({
    github: review.github.id,
    model: review.model,
    gate: review.gate,
    audit: review.audit
  })
}

function provided(value, children) {
  return jsx(ReviewContext.Provider, { value, children })
}

test("nested phase Providers preserve the flat request-scoped review context", async () => {
  const initial = reviewValue("request-1")
  const audit = { summary: "audit" }
  const value = await runtime().evaluate(provided(initial, provided({ ...initial, audit }, jsx(ReadReview, {}))))

  assert.deepEqual(JSON.parse(value), {
    github: "request-1",
    model: "request-1",
    gate: { decision: "review", reason: "request-1", source: "deterministic" },
    audit
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

test("ReviewOutcome selects and publishes exactly once", () => {
  const outcome = new ReviewOutcome()
  const draft = {
    status: "no-review",
    gate: { decision: "no-review", answer: "Already reviewed.", source: "deterministic" },
    body: "Already reviewed.\n\n✅ LGTM"
  }

  assert.throws(() => outcome.selected(), /without selecting a draft/u)
  assert.throws(() => outcome.result(), /without a publication outcome/u)

  outcome.select(draft)
  assert.deepEqual(outcome.selected(), draft)
  assert.throws(() => outcome.select(draft), /already selected a draft/u)

  outcome.publish(draft, null)
  assert.deepEqual(outcome.result(), { review: draft, publicationError: null })
  assert.throws(() => outcome.publish(draft, null), /already complete/u)
})
