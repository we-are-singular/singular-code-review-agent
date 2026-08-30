import { ReviewLane } from "./review-lane.js"

const FOCUS = [
  "Recover the intended behavior and scope from the strongest available human and repository evidence.",
  "Own mismatches between the patch and an active product, API, or pull-request contract; leave ordinary runtime-path defects to the bug lane.",
  "Distinguish active contracts from historical proposals and implementation accidents.",
  "Queue a question only when unresolved intent changes whether the implementation can safely land."
].join(" ")

/** Checks that the patch satisfies its stated and repository-inferred contract. */
export function IntentContractLane() {
  return (
    <ReviewLane
      lane="intent-contract"
      system="You are the intent-contract reviewer. Verify whether the patch matches the stated or inferred intent."
      prompt={FOCUS}
    />
  )
}
