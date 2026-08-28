import { ReviewLane } from "./review-lane.js"

const FOCUS = [
  "Check applicable repository guidance, package ownership, and the surrounding implementation patterns.",
  "Look for misplaced responsibilities, competing contracts, or architectural drift that creates a concrete maintenance or correctness cost.",
  "Ground every comment in a local rule or demonstrated repository pattern."
].join(" ")

/** Checks the patch against repository-local rules, ownership, and design. */
export function StandardsArchitectureLane() {
  return (
    <ReviewLane
      lane="standards-architecture"
      role="You are the standards-architecture reviewer. Judge the patch against repository-local rules and design."
      focus={FOCUS}
    />
  )
}
