import { System } from "@aml-jsx/sdk"

import { Block } from "../block.js"
import { ReviewLane } from "./review-lane.js"

/** Checks that the patch satisfies its stated and repository-inferred contract. */
export function IntentContractLane() {
  return (
    <>
      ## Intent
      <ReviewLane lane="intent-contract">
        <System>
          You are the intent-contract reviewer. Verify whether the patch matches the stated or inferred intent.
        </System>
        {/* prettier-ignore */}
        <Block>
        - Recover the intended behavior and scope from the strongest available human and repository evidence.
        - Own mismatches between the patch and an active product, API, pull-request, or repository contract; leave ordinary runtime-path defects to the bug lane.
        - Distinguish active contracts from historical proposals and implementation accidents.
        - Queue a question only when unresolved intent changes whether the implementation can safely land.
      </Block>
      </ReviewLane>
    </>
  )
}
