import { Agent, evaluate } from "@aml-jsx/sdk"
import { z } from "zod"

import { REVIEW_CONTEXT_PATHS } from "../components/review-context-files.js"
import { useReview } from "../review-context.js"
import type { ReviewFinding } from "../services/review-findings.js"
import type { ReviewDraft } from "../review-result.js"

const SynthesisSchema = z
  .object({
    direct_answer: z.string().trim().min(1).max(2_000).nullable(),
    summary: z.string().trim().min(1).max(2_000),
    recommendation: z.string().trim().min(1).max(1_000).nullable()
  })
  .strict()

function SynthesisAgent({ evidence }: { evidence: unknown }) {
  return (
    <Agent
      name="review-synthesis"
      permissions={{ filesystem: "read-only", network: false, shell: false }}
      system="You write a concise pull-request review summary from validated evidence without inventing findings."
    >
      {`Write the author-facing summary for this validated review:

${JSON.stringify(evidence, null, 2)}

Use ${REVIEW_CONTEXT_PATHS.pullRequest} to understand the change and ${REVIEW_CONTEXT_PATHS.history} when the trigger or prior discussion matters. The validated findings are the exhaustive set of author-visible actions. Never invent or resurrect one.

Set direct_answer only when a top-level trigger_request or mentioned action item both asks a direct question or gives an instruction and this run continued into a full review. Address the commenter with the exact @username from participants when available, answer concisely, and do not include review headings. A reply_requested item belongs in its existing review thread through add_review_reply, never in direct_answer. Otherwise set direct_answer to null.

Return a two- or three-sentence summary explaining what changed, what the implementation gets right, and overall readiness. Keep a clean review compact and confident; do not hedge with internal residual risks or testing notes when there is no author-actionable finding.

Critical review-level blockers are rendered verbatim by the application under Recommendations. Account for them when describing readiness, but do not repeat their mechanism or action. Set recommendation to null unless the remaining retained findings share useful high-level guidance that is not already expressed by their inline comments or replies. A recommendation is one concise paragraph, not a findings list. Do not include headings, verdicts, process descriptions, paths, or comment counts.`}
    </Agent>
  )
}

function verdict(findings: ReviewFinding[]): "⛔ Block" | "⚠️ Request changes" | "✅ LGTM" {
  if (findings.some(finding => finding.kind === "blocker" || finding.severity === "critical")) {
    return "⛔ Block"
  }
  if (findings.some(finding => finding.severity !== "hint" && finding.severity !== "nit")) {
    return "⚠️ Request changes"
  }
  return "✅ LGTM"
}

/** Selects the final draft after one small, typed prose pass. */
export async function ReviewSynthesis() {
  const review = useReview()
  if (!review.gate || !review.audit || !review.validated) {
    throw new Error("ReviewSynthesis requires gate, audit, and validation results")
  }

  const lanes = review.findings.completed()
  const topLevelActionItems = review.snapshot.reviewerContext.action_items.filter(
    item => item.kind === "trigger_request" || item.kind === "mentioned"
  )
  const synthesis = await evaluate(
    <SynthesisAgent
      evidence={{
        audit: review.audit,
        lane_assessments: lanes,
        retained_findings: review.validated.findings,
        inline_comments: review.validated.queue.inlineComments,
        replies: review.validated.queue.replies,
        conversation: {
          participants: review.snapshot.reviewerContext.participants,
          top_level_action_items: topLevelActionItems
        }
      }}
    />,
    SynthesisSchema
  )
  const blockers = review.validated.findings.filter(finding => finding.kind === "blocker")
  const finalVerdict = verdict(review.validated.findings)
  // Thread replies are published beside their original comment. Even if a
  // provider ignores the prompt, they must never leak into the top-level body.
  const directAnswer = topLevelActionItems.length > 0 ? synthesis.direct_answer : null
  const body = directAnswer
    ? [directAnswer, "", "## Review Summary", "", synthesis.summary]
    : ["## Review Summary", "", synthesis.summary]
  if (blockers.length > 0 || (synthesis.recommendation && finalVerdict !== "✅ LGTM")) {
    body.push("", "## Recommendations", "")
    for (const blocker of blockers) {
      body.push(`- **${blocker.title}:** ${blocker.body}`)
    }
    if (synthesis.recommendation && finalVerdict !== "✅ LGTM") {
      if (blockers.length > 0) {
        body.push("")
      }
      body.push(synthesis.recommendation)
    }
  }
  body.push("", "## Verdict", "", finalVerdict)

  const draft: ReviewDraft = {
    status: "reviewed",
    gate: review.gate,
    lanes,
    audit: review.audit,
    validated: review.validated.queue,
    body: body.join("\n")
  }

  review.outcome.select(draft)
  return ""
}
