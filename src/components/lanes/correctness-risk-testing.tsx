import { ReviewLane } from "./review-lane.js"

const FOCUS = [
  "Own consequential boundary risk: security, authorization, data integrity, compatibility, concurrency, performance, rollout, and behavioral proof.",
  "Trace changed behavior to those boundaries and inspect other risks only when the diff makes them relevant.",
  "Use current callers and deployment paths to distinguish supported behavior from hypothetical scenarios.",
  "When schema, persisted data, or deployed runtime assumptions change, inspect the actual rollout order and old/new version overlap instead of assuming an atomic deploy.",
  "Inspect partial-update paths for lost atomicity and independent asynchronous work for accidental serialization when the change can affect correctness, latency, or resource use.",
  "Verify that tests reach the boundary whose behavior changed; stage a test gap only when it leaves a specific realistic regression unguarded, and name the smallest useful proof rather than restaging the underlying bug."
].join(" ")

/** Checks correctness, security, compatibility, and behavioral proof. */
export function CorrectnessRiskTestingLane() {
  return (
    <ReviewLane
      lane="correctness-risk-testing"
      system="You are the correctness-risk-testing reviewer. Find user, data, security, compatibility, and proof failures."
      prompt={FOCUS}
    />
  )
}
