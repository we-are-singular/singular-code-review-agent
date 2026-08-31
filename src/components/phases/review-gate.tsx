import { Agent, evaluate, Skill } from "@aml-jsx/sdk"
import { z } from "zod"

import { Block } from "../block.js"
import { prepareGate } from "../../lib/review-gate.js"
import { REVIEW_CONTEXT_PATHS } from "../review-context-files.js"
import { useReviewContext } from "../review-context.js"

const GateDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("review"), reason: z.string().trim().min(1).max(1_000) }).strict(),
  z.object({ decision: z.literal("no-review"), answer: z.string().trim().min(1).max(4_000) }).strict(),
  z.object({ decision: z.literal("answer"), answer: z.string().trim().min(1).max(4_000) }).strict()
])

export type ReviewGateResult = z.infer<typeof GateDecisionSchema> & {
  source: "bypass" | "deterministic" | "agent"
}

function GateAgent({ context, delta }: { context: unknown; delta: string }) {
  return (
    <Agent
      name="review-gate"
      permissions={{ filesystem: "read-only", network: false, shell: false }}
      system="You route pull-request follow-up events. Fast-track only evidence-backed, low-risk deltas and escalate uncertainty to a full review."
    >
      <Skill name="Review gate policy" src="./skills/gate.md" />
      <Block>
        Decide whether this event needs a full review, can be answered directly, or needs no review. Gate context:
        <Block>{JSON.stringify(context, null, 2)}</Block>
        Delta from the last completed review:
        <Block>{delta}</Block>
        The supplied context and delta are normally sufficient. Read {REVIEW_CONTEXT_PATHS.pullRequest} only when stated
        intent matters and {REVIEW_CONTEXT_PATHS.history} only when prior conversation is necessary to classify the
        latest change.
      </Block>
    </Agent>
  )
}

/** Uses deterministic event/history rules before paying for an Agent decision. */
export async function decideReviewGate(): Promise<ReviewGateResult> {
  const { github, snapshot } = useReviewContext()
  const prepared = prepareGate(snapshot, github.request.workspace)

  if (prepared.action === "post") {
    return { ...prepared.decision, source: "deterministic" }
  }
  if (prepared.action === "review") {
    return {
      decision: "review",
      reason: prepared.reason,
      source: prepared.reason.startsWith("gate is not used") ? "bypass" : "deterministic"
    }
  }

  const decision = await evaluate(
    <GateAgent context={prepared.context} delta={prepared.deltaText} />,
    GateDecisionSchema
  )
  return { ...decision, source: "agent" }
}
