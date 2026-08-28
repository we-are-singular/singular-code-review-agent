import { ReviewLane } from "./review-lane.js"

const FOCUS = [
  "Check active documentation only when this change alters behavior that users or operators rely on.",
  "Treat a mismatch as actionable only when the document is active and can mislead a current user or operator.",
  "Preserve active specifications and repository guidance that contradict current supported behavior; stale wording whose only cost is possible future drift is not a finding.",
  "Check comments for non-obvious contracts and rationale rather than asking them to restate code."
].join(" ")

/** Checks that changed behavior remains understandable and operable. */
export function DocumentationCommentaryLane() {
  return (
    <ReviewLane
      lane="documentation-commentary"
      role="You are the documentation-commentary reviewer. Keep changed behavior understandable and operable."
      focus={FOCUS}
    />
  )
}
