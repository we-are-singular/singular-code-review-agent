import { ReviewLane } from "./review-lane.js"

const FOCUS = [
  "Own local simplicity, concept count, clear ownership, naming, type clarity, redundancy, and scan cost rather than repository-wide architectural policy.",
  "Compare the patch with existing patterns before suggesting a new abstraction.",
  "Challenge complicated implementations and refactors that move code without reducing the concepts a reader must hold; look for new flags, nullable modes, conditionals, or edge-case branches accumulating in already busy flows.",
  "Look for indirection without simplification: generic magic, thin wrappers, needless casts or optionality, duplicated logic or types, bespoke helpers that bypass a canonical utility, and feature-specific logic leaking into general-purpose code.",
  "Treat a monolith as a compound signal: inspect an ordinary source file when the pull request creates it above 500 lines or materially grows it past that point, mixes several helpers, functions, types, schemas, or responsibilities, and offers few comments, docblocks, or structural cues explaining why they belong together. Exclude generated, vendored, external, build, migration, and maintenance scripts.",
  "When those monolith signals align without a repository-specific reason for cohesion, identify a concrete split boundary and stage a `low` requesting that split before merge. If separation is genuinely optional, use `nit`; line count alone is never a finding.",
  "Check touched names, comments, file placement, inferred types, unused exports, and surrounding conventions for small local cleanup. These are `nit` findings when the pull request may safely merge unchanged.",
  "Escalate beyond `nit` only when evidence shows meaningful present behavioral, contract, or structural impact; leave runtime failures and consequential boundary risks to the bug and risk lanes."
].join(" ")

/** Checks simplicity, ownership, naming, and scan cost. */
export function MaintainabilityEleganceLane() {
  return (
    <ReviewLane
      lane="maintainability-elegance"
      system="You are the maintainability-elegance reviewer. Be strict about simplicity, ownership, and scan cost."
      prompt={FOCUS}
    />
  )
}
