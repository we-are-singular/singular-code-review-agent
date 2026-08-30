import { ReviewLane } from "./review-lane.js"

const FOCUS = [
  "Own repository rules, package and layer ownership, canonical sources, and established architecture or naming conventions.",
  "Look for feature-specific logic leaking into general-purpose modules, responsibilities placed in the wrong layer or package, competing contracts, and bespoke helpers that bypass an existing canonical owner.",
  "Treat structural drift as actionable only when it has a concrete present cost; local placement or consistency cleanup that may safely remain belongs to the elegance lane as a `nit`.",
  "Ground every comment in a local rule or demonstrated repository pattern; leave local simplification to the elegance lane and reachable runtime failures to the bug lane."
].join(" ")

/** Checks the patch against repository-local rules, ownership, and design. */
export function StandardsArchitectureLane() {
  return (
    <ReviewLane
      lane="standards-architecture"
      system="You are the standards-architecture reviewer. Judge the patch against repository-local rules and design."
      prompt={FOCUS}
    />
  )
}
