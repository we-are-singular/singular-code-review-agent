import { Agent, evaluate, Skill, type AmlRenderable } from "@aml-jsx/sdk"
import { z } from "zod"

import { REVIEW_CONTEXT_PATHS } from "../review-context-files.js"
import { useReviewContext } from "../review-context.js"
import type { ReviewDraft } from "../../types/review.js"
import type { ReviewFinding } from "../../lib/review-queue.js"

const SynthesisSchema = z
  .object({
    direct_answer: z.string().trim().min(1).max(2_000).nullable(),
    summary: z.string().trim().min(1).max(2_000),
    next_steps: z.string().trim().min(1).max(1_000).nullable()
  })
  .strict()

function SynthesisEvidence() {
  const review = useReviewContext()
  if (!review.gate || !review.audit || !review.validated) {
    throw new Error("ReviewSynthesis requires gate, audit, and validation results")
  }

  const lanes = review.queue.completed()
  const finalVerdict = verdict(review.validated.findings)
  const topLevelActionItems = review.snapshot.actionItems.filter(
    item => item.kind === "trigger_request" || item.kind === "mentioned"
  )

  return `\n\nWrite the author-facing main review body from this application-owned final evidence:

${JSON.stringify(
  {
    lane_assessments: lanes,
    final_review: {
      findings: review.validated.findings,
      verdict: finalVerdict
    },
    conversation: {
      participants: review.snapshot.participants,
      top_level_action_items: topLevelActionItems
    }
  },
  null,
  2
)}

Use ${REVIEW_CONTEXT_PATHS.pullRequest} to understand the change and ${REVIEW_CONTEXT_PATHS.history} when the trigger or prior discussion matters.`
}

function SynthesisAgent({ children }: { children: AmlRenderable }) {
  return (
    <Agent
      name="review-synthesis"
      permissions={{ filesystem: "read-only", network: false, shell: false }}
      system="You write a concise pull-request review summary from validated evidence without inventing findings."
    >
      <Skill name="Review synthesis policy" src="./skills/synthesis.md" />
      {`\n\nThe validated audit handoff resolves below before synthesis starts. Treat it as explanatory context; the application-owned final evidence that follows is authoritative.`}
      {children}
      <SynthesisEvidence />
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

/** Collects one typed synthesis result after validation resolves the nested audit tree. */
export async function ReviewSynthesis({ children }: { children: AmlRenderable }) {
  const review = useReviewContext()
  if (!review.gate) {
    throw new Error("ReviewSynthesis requires a full-review gate decision")
  }

  const synthesis = await evaluate(<SynthesisAgent>{children}</SynthesisAgent>, SynthesisSchema)
  if (!review.audit || !review.validated) {
    throw new Error("ReviewSynthesis completed without audit and validation results")
  }

  const lanes = review.queue.completed()
  const audit = review.audit
  const validated = review.validated
  const finalVerdict = verdict(validated.findings)
  const topLevelActionItems = review.snapshot.actionItems.filter(
    item => item.kind === "trigger_request" || item.kind === "mentioned"
  )
  const blockers = validated.findings.filter(finding => finding.kind === "blocker")
  // Thread replies are published beside their original comment. Even if a
  // provider ignores the prompt, they must never leak into the top-level body.
  const directAnswer = topLevelActionItems.length > 0 ? synthesis.direct_answer : null
  // Recommendations coordinate requested work; an LGTM has no required work
  // regardless of prose a provider returns against the structured contract.
  const nextSteps = finalVerdict === "✅ LGTM" ? null : synthesis.next_steps
  const body = directAnswer
    ? [directAnswer, "", "## Review Summary", "", synthesis.summary]
    : ["## Review Summary", "", synthesis.summary]
  if (blockers.length > 0 || nextSteps) {
    body.push("", "## Recommendations", "")
    for (const blocker of blockers) {
      body.push(`- ${blocker.body}`)
    }
    if (blockers.length > 0 && nextSteps) {
      body.push("")
    }
    if (nextSteps) {
      body.push(nextSteps)
    }
  }
  body.push("", "## Verdict", "", finalVerdict)

  const draft: ReviewDraft = {
    status: "reviewed",
    gate: review.gate,
    lanes,
    audit,
    validated: validated.queue,
    body: body.join("\n")
  }

  review.outcome.select(draft)
  return ""
}
