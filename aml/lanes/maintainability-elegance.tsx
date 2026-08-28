import { ReviewLane } from "./review-lane.js"

const FOCUS = [
  "Compare the patch with existing patterns before suggesting a new abstraction.",
  "Look for unnecessary concepts, vague ownership, misleading names, or duplication likely to drift, and prefer the smallest safe simplification.",
  "Queue maintainability feedback only when it has a concrete near-term benefit rather than expressing taste."
].join(" ")

/** Checks simplicity, ownership, naming, and scan cost. */
export function MaintainabilityEleganceLane() {
  return (
    <ReviewLane
      lane="maintainability-elegance"
      role="You are the maintainability-elegance reviewer. Be strict about simplicity, ownership, and scan cost."
      focus={FOCUS}
    />
  )
}
