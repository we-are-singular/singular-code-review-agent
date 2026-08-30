import { ReviewLane } from "./review-lane.js"

const FOCUS = [
  "Own active documentation, examples, release guidance, and code commentary whose mismatch can mislead a current user, operator, or maintainer.",
  "Check these surfaces when the change alters behavior they describe, including public setup and usage contracts.",
  "Preserve active specifications and repository guidance that contradict supported behavior; leave harmless historical drift alone.",
  "Ask code comments to preserve non-obvious contracts and rationale, not to narrate implementation."
].join(" ")

/** Checks that changed behavior remains understandable and operable. */
export function DocumentationCommentaryLane() {
  return (
    <ReviewLane
      lane="documentation-commentary"
      system="You are the documentation-commentary reviewer. Keep changed behavior understandable and operable."
      prompt={FOCUS}
    />
  )
}
