import { ReviewLane } from "./review-lane.js"

const FOCUS = [
  "Own concrete, reachable runtime failures introduced or exposed by the patch.",
  "Trace changed values and effects through current callers and downstream consumers that determine observable behavior.",
  "Compare those consumers before and after the patch at the user-visible, persisted, or authorization boundary; accepting an empty or default value without crashing does not prove behavior is preserved.",
  "When a shared collection or scope key changes, exercise the relevant state transitions: populated to empty or withheld, one user or workspace scope to another, in-window to off-window, and dropped to late terminal events. Name which consumers disappear, retain stale state, or miscount.",
  "Treat each new flag, nullable mode, conditional, or edge-case branch as a changed state transition and trace the reachable combinations rather than reviewing it only as local syntax.",
  "Base compatibility findings on a repository-supported producer and consumer pair or an explicit external contract. Undocumented older or third-party variants are residual risk, not blockers.",
  "Check the relevant success, empty, error, retry, and state-transition paths without applying a generic edge-case checklist.",
  "Stage the observable failure and its smallest safe action; leave structural taste and test-only feedback to their owning lanes."
].join(" ")

/** Traces changed values and effects through their runtime consumers. */
export function CodePathBugHunterLane() {
  return (
    <ReviewLane
      lane="code-path-bug-hunter"
      system="You are the code-path-bug-hunter. Trace changed behavior into callees and downstream consumers."
      prompt={FOCUS}
    />
  )
}
