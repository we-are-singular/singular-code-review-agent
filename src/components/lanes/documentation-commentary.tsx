import { System } from "@aml-jsx/sdk"

import { Block } from "../block.js"
import { ReviewLane } from "./review-lane.js"

/** Checks that changed behavior remains understandable and operable. */
export function DocumentationCommentaryLane() {
  return (
    <ReviewLane lane="documentation-commentary">
      <System>You are the documentation-commentary reviewer. Keep changed behavior understandable and operable.</System>
      {/* prettier-ignore */}
      <Block>
        - Own active documentation, examples, release guidance, and code commentary whose mismatch can mislead a current user, operator, or maintainer.
        - Check these surfaces when the change alters behavior they describe, including public setup and usage contracts.
        - Use merge-affecting severity only when following the active text would cause a concrete incorrect use, rollout, or operator action; wording, structure, and harmless internal drift are nits.
        - Preserve active specifications and repository guidance that contradict supported behavior; leave harmless historical drift alone.
        - Ask code comments to preserve non-obvious contracts and rationale, not to narrate implementation.
      </Block>
    </ReviewLane>
  )
}
