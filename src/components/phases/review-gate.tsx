import { Agent, evaluate, Skill, type AmlRenderable } from "@aml-jsx/sdk"
import { z } from "zod"

import { prepareGate } from "../../lib/review-gate.js"
import { REVIEW_CONTEXT_PATHS } from "../review-context-files.js"
import { ReviewContext, useReviewContext } from "../review-context.js"
import type { ReviewDraft } from "../../types/review.js"

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
      {`Decide whether this event needs a full review, can be answered directly, or needs no review.

Gate context:
${JSON.stringify(context, null, 2)}

Delta from the last completed review:
${delta}

The supplied context and delta are normally sufficient. Read ${REVIEW_CONTEXT_PATHS.pullRequest} only when stated intent matters and ${REVIEW_CONTEXT_PATHS.history} only when prior conversation is necessary to classify the latest change.`}
    </Agent>
  )
}

/** Gives every confident no-review decision the same idempotent approval marker. */
function gateBody(gate: Extract<ReviewGateResult, { decision: "answer" | "no-review" }>): string {
  const answer = gate.answer.trim()
  if (gate.decision === "answer") {
    return answer
  }

  // Providers occasionally include the marker despite the prompt. Normalize
  // only that exact terminal contract before appending the application-owned line.
  const withoutExistingVerdict = answer.replace(/(?:^|\n+)\s*✅\s*LGTM\.?\s*$/u, "").trim()
  return withoutExistingVerdict ? `${withoutExistingVerdict}\n\n✅ LGTM` : "✅ LGTM"
}

/** Uses deterministic event/history rules before paying for an Agent decision. */
async function decideGate(): Promise<ReviewGateResult> {
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

/**
 * Routes cheap events to a final response or evaluates the full-review subtree.
 *
 * This component is the workflow's intentional router/orchestrator: it owns the
 * conditional evaluation boundary while Agents below it retain post-order flow.
 */
export async function ReviewGate({ children }: { children: AmlRenderable }) {
  const review = useReviewContext()
  const gate = await decideGate()
  if (gate.decision !== "review") {
    const result: ReviewDraft = {
      status: gate.decision === "answer" ? "answered" : "no-review",
      gate,
      body: gateBody(gate)
    }
    review.outcome.select(result)
    return ""
  }

  await evaluate(<ReviewContext.Provider value={{ ...review, gate }}>{children}</ReviewContext.Provider>)
  return ""
}
