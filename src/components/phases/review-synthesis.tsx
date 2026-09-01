import { Agent, Block, evaluate, Include, type AmlRenderable } from "@aml-jsx/sdk"
import { z } from "zod"

import { REVIEW_INCLUDE_MAX_BYTES } from "../../config.js"
import { ReviewContextPrompt } from "../review-context-prompt.js"
import { useReviewContext } from "../review-context.js"
import type { ReviewFinding } from "../../lib/review-queue.js"

const SynthesisSchema = z
  .object({
    direct_answer: z.string().trim().min(1).max(2_000).nullable(),
    summary: z.string().trim().min(1).max(2_000),
    next_steps: z.string().trim().min(1).max(1_000).nullable()
  })
  .strict()

function SynthesisAgent({ children, evidence }: { children: AmlRenderable; evidence: unknown }) {
  return (
    <Agent
      name="review-synthesis"
      permissions={{ filesystem: "read-only", network: false, shell: false }}
      system="You write a concise pull-request review summary from validated evidence without inventing findings."
    >
      <Block tag="synthesis-policy">
        <Include src="./instructions/synthesis.md" maxBytes={REVIEW_INCLUDE_MAX_BYTES} title={false} />
      </Block>
      <Block tag="audit-handoff">
        The validated audit handoff resolves below before synthesis starts. Treat it as explanatory context; the
        application-owned final evidence that follows is authoritative.
        <Block>{children}</Block>
      </Block>
      <Block>
        Write the author-facing main review body from this application-owned final evidence:
        <Block tag="validated-review">{JSON.stringify(evidence, null, 2)}</Block>
        Use the pull-request context below to understand the change. The application-owned conversation above contains
        the only prior discussion relevant to this top-level response.
        <ReviewContextPrompt />
      </Block>
    </Agent>
  )
}

function verdict(findings: ReviewFinding[]): "⛔ Block" | "⚠️ Request changes" | "✅ LGTM" {
  if (
    findings.some(
      finding => finding.kind === "blocker" || (finding.kind === "inline" && finding.severity === "critical")
    )
  ) {
    return "⛔ Block"
  }
  if (findings.some(finding => finding.kind === "inline" && finding.severity !== "nit")) {
    return "⚠️ Request changes"
  }
  return "✅ LGTM"
}

/** Resolves audit, finalizes its queue, and returns the composed author-facing review body. */
export async function ReviewSynthesis({ children }: { children: AmlRenderable }) {
  const review = useReviewContext()
  const auditHandoff = await evaluate(children)
  const lanes = review.queue.completed()
  const validated = review.queue.finalize()
  const finalVerdict = verdict(validated.findings)
  const topLevelActionItems = review.snapshot.actionItems.filter(
    item => item.kind === "trigger_request" || item.kind === "mentioned"
  )
  const synthesis = await evaluate(
    <SynthesisAgent
      evidence={{
        lane_assessments: lanes,
        final_review: {
          findings: validated.findings,
          verdict: finalVerdict
        },
        conversation: {
          participants: review.snapshot.participants,
          top_level_action_items: topLevelActionItems
        }
      }}
    >
      {auditHandoff}
    </SynthesisAgent>,
    SynthesisSchema
  )
  const blockers = validated.findings.filter(finding => finding.kind === "blocker")
  // Thread replies are published beside their original comment. Even if a
  // provider ignores the prompt, they must never leak into the top-level body.
  const directAnswer = topLevelActionItems.length > 0 ? synthesis.direct_answer : null
  // Recommendations coordinate requested work; an LGTM has no required work
  // regardless of prose a provider returns against the structured contract.
  const nextSteps = finalVerdict === "✅ LGTM" ? null : synthesis.next_steps
  const recommendations = blockers.map(blocker => `- ${blocker.body}`)
  if (nextSteps) {
    if (recommendations.length > 0) {
      recommendations.push("")
    }
    recommendations.push(nextSteps)
  }

  return (
    <>
      {directAnswer ? <Block>{directAnswer}</Block> : null}
      ## Review Summary
      <Block>{synthesis.summary}</Block>
      {recommendations.length > 0 ? (
        <>
          ## Recommendations
          <Block>{recommendations.join("\n")}</Block>
        </>
      ) : null}
      ## Verdict
      <Block>{finalVerdict}</Block>
    </>
  )
}
