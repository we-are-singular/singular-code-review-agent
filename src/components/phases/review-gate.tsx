import { Agent, Block, evaluate, Include } from "@aml-jsx/sdk"
import { z } from "zod"

import { prepareGate, type GateDeltaMode } from "../../lib/review-gate.js"
import { REVIEW_POLICY_INCLUDE_LIMIT_BYTES } from "../../prompt-limits.js"
import { REVIEW_CONTEXT_PATHS } from "../context/files.js"
import { ReviewContextPrompt } from "../context/prompt.js"
import { useReviewContext } from "../context/review-context.js"

const NoReviewAnswerSchema = z
  .string()
  .trim()
  .min(1)
  .max(600)
  .refine(value => value.split(/\s+/u).length <= 80, "no-review answer must contain at most 80 words")

const GateDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("review"), reason: z.string().trim().min(1).max(1_000) }).strict(),
  z.object({ decision: z.literal("no-review"), answer: NoReviewAnswerSchema }).strict(),
  z.object({ decision: z.literal("answer"), answer: z.string().trim().min(1).max(4_000) }).strict()
])

type GateDecision = z.infer<typeof GateDecisionSchema>
type GateSource = "bypass" | "deterministic" | "agent"

export type ReviewGateResult =
  | (Extract<GateDecision, { decision: "review" | "answer" }> & { source: GateSource })
  | (Extract<GateDecision, { decision: "no-review" }> & {
      source: GateSource
      comparisonMode: GateDeltaMode | null
    })

function GateAgent({ context, delta }: { context: unknown; delta: string }) {
  return (
    <Agent
      name="review-gate"
      permissions={{ filesystem: "read-only", network: false, shell: false }}
      system="You route pull-request follow-up events. Decide whether this event needs a full review, can be answered directly, or needs no review. Fast-track only evidence-backed, low-risk deltas and escalate uncertainty to a full review."
    >
      <Block tag="gate-policy">
        <Include src="./instructions/gate.md" maxBytes={REVIEW_POLICY_INCLUDE_LIMIT_BYTES} title={false} />
      </Block>
      <Block tag="gate-context">{JSON.stringify(context, null, 2)}</Block>
      <Block tag="review-delta">{delta}</Block>
      <Block>
        The supplied context and delta are normally sufficient. Use the materialized PR and referenced-issue context
        below when stated intent or requirement coverage matters, and read {REVIEW_CONTEXT_PATHS.history} only when
        prior PR conversation is necessary to classify the latest change.
        <ReviewContextPrompt issues />
      </Block>
    </Agent>
  )
}

/** Uses deterministic event/history rules before paying for an Agent decision. */
export async function decideReviewGate(): Promise<ReviewGateResult> {
  const { github, snapshot } = useReviewContext()
  const prepared = prepareGate(snapshot, github.request.workspace)

  if (prepared.action === "post") {
    return prepared.decision.decision === "no-review"
      ? { ...prepared.decision, source: "deterministic", comparisonMode: prepared.comparisonMode }
      : { ...prepared.decision, source: "deterministic" }
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
  // A no-review approval can only describe continuity when Git established a
  // usable prior review anchor. Otherwise the full review owns readiness.
  if (
    decision.decision === "no-review" &&
    (prepared.context.delta.mode === "no_previous_review" || prepared.context.delta.mode === "unavailable")
  ) {
    return {
      decision: "review",
      reason: "no-review requires a comparable previous review",
      source: "deterministic"
    }
  }
  return decision.decision === "no-review"
    ? { ...decision, source: "agent", comparisonMode: prepared.context.delta.mode }
    : { ...decision, source: "agent" }
}
