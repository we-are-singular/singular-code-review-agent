import { Agent, evaluate, type AmlRenderable } from "@aml-jsx/sdk"
import { z } from "zod"

import { prepareGate } from "../../src/review/gate.js"
import { GitHubReadTools } from "../components/github-read-tools.js"
import { ReviewContext, useReview } from "../review-context.js"
import type { ReviewDraft } from "../review-result.js"

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
      <GitHubReadTools />
      {`Decide whether this event needs a full review, can be answered directly, or needs no review.

Gate context:
${JSON.stringify(context, null, 2)}

Delta from the last completed review:
${delta}

This is a routing check, not a second full review. Use the chronological context, previous findings, and delta to inspect only enough evidence to classify the latest change.

Choose review when the delta introduces behavior outside the scope of previous feedback, leaves a prior finding unresolved, expands an adjacent contract, lacks trustworthy history, or is otherwise uncertain. An explicit request for a full review or re-review also requires review.

Choose no-review only when you are confident the delta is documentation-only, formatting-only, rebase-only, already reviewed, or a contained response to previous review feedback with no new meaningful risk. A contained runtime fix must be narrow, map directly to a previous finding, and be mechanically easy to verify from the delta. Focused edits within one component may qualify when direct tests cover the fix. Tests are supporting evidence, not proof that a broader change is contained. Escalate fixes that cross runtime component boundaries, rewrite a substantial runtime surface, or introduce several interacting behavior changes even when each part relates to prior feedback. If deciding no-review would require doing a full review, choose review. Briefly state what changed and why a full review is unnecessary. Do not include an LGTM marker because the application appends it deterministically.

Choose answer only for a conversational request that can be answered from the pull-request evidence without reviewing code.

Do not publish anything. Return only the structured gate decision. Keep answers concise and author-facing.`}
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
  const { github, snapshot } = useReview()
  const prepared = prepareGate({
    context: snapshot.context,
    workspace: github.request.workspace,
    diffText: snapshot.diff,
    botLogin: github.request.botLogin
  })

  if (prepared.action === "post") {
    return { ...prepared.decision, source: "deterministic" }
  }
  if (prepared.action === "run-review") {
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

/** Stops cheap events at the gate or exposes a typed review decision downstream. */
export async function ReviewGate({ children }: { children: AmlRenderable }) {
  const review = useReview()
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

  return <ReviewContext.Provider value={{ ...review, gate }}>{children}</ReviewContext.Provider>
}
