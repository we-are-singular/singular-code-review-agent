import { ReviewLane } from "./review-lane.js"

const FOCUS = [
  "Trace the changed behavior to its consequential boundaries.",
  "Prioritize reachable regressions in security, data integrity, compatibility, or public behavior; inspect other risks only when the diff makes them relevant.",
  "Use current callers and deployment paths to distinguish supported behavior from hypothetical scenarios.",
  "When schema, persisted data, or deployed runtime assumptions change, inspect the actual rollout order and old/new version overlap instead of assuming an atomic deploy.",
  "Verify that tests reach the boundary whose behavior changed; queue a test gap only when it leaves a specific realistic regression unguarded, and name the smallest useful proof."
].join(" ")

/** Checks correctness, security, compatibility, and behavioral proof. */
export function CorrectnessRiskTestingLane() {
  return (
    <ReviewLane
      lane="correctness-risk-testing"
      role="You are the correctness-risk-testing reviewer. Find user, data, security, compatibility, and proof failures."
      focus={FOCUS}
    />
  )
}
