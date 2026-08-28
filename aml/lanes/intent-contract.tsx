import { ReviewLane } from "./review-lane.js"

const FOCUS = [
  "Recover the intended behavior and scope from the strongest available human and repository evidence.",
  "Distinguish active contracts from historical proposals, then check whether the patch actually satisfies them.",
  "Queue a question only when unresolved intent changes whether the implementation can safely land."
].join(" ")

/** Checks that the patch satisfies its stated and repository-inferred contract. */
export function IntentContractLane() {
  return (
    <ReviewLane
      lane="intent-contract"
      role="You are the intent-contract reviewer. Verify whether the patch matches the stated or inferred intent."
      focus={FOCUS}
    />
  )
}
