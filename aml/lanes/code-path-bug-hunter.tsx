import { ReviewLane } from "./review-lane.js"

const FOCUS = [
  "Trace changed values and effects through the current callers and downstream consumers that determine observable behavior.",
  "Compare those consumers before and after the patch at the user-visible, persisted, or authorization boundary; accepting an empty or default value without crashing does not prove behavior is preserved.",
  "Check the relevant success, empty, error, retry, and state-transition paths without applying a generic edge-case checklist.",
  "Queue only a reachable failure introduced or exposed by the patch; summarize important paths that you verified clean."
].join(" ")

/** Traces changed values and effects through their runtime consumers. */
export function CodePathBugHunterLane() {
  return (
    <ReviewLane
      lane="code-path-bug-hunter"
      role="You are the code-path-bug-hunter. Trace changed behavior into callees and downstream consumers."
      focus={FOCUS}
    />
  )
}
