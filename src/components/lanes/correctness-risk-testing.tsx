import { Block, System } from "@aml-jsx/sdk"

import { ReviewLane } from "./review-lane.js"

/** Checks correctness, security, compatibility, and behavioral proof. */
export function CorrectnessRiskTestingLane() {
  return (
    <>
      ## Risk and testing
      <ReviewLane lane="correctness-risk-testing">
        <System>
          You are the correctness-risk-testing reviewer. Find user, data, security, compatibility, and proof failures.
        </System>
        {/* prettier-ignore */}
        <Block>
        - Own consequential boundary risk: security, authorization, data integrity, compatibility, concurrency, performance, rollout, and behavioral proof.
        - Trace changed behavior to those boundaries and inspect other risks only when the diff makes them relevant.
        - Use current callers, public entry points, and deployment paths to distinguish supported behavior from hypothetical scenarios.
        - When schema, persisted data, or deployed runtime assumptions change, inspect the actual rollout order and old/new version overlap instead of assuming an atomic deploy.
        - Inspect partial-update paths for lost atomicity and independent asynchronous work for accidental serialization when the change can affect correctness, latency, or resource use.
        - Verify that tests reach the boundary whose behavior changed; stage a test gap only when it leaves a specific realistic regression unguarded, and name the smallest useful proof rather than restaging the underlying bug.
        - Leave a concrete replay execution trace to the bug lane; own it here only when it establishes a cross-cutting boundary or behavioral-proof failure.
      </Block>
      </ReviewLane>
    </>
  )
}
