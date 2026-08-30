import { Agent, evaluate, Skill, Tool, type AmlRenderable } from "@aml-jsx/sdk"

import { REVIEW_CONTEXT_PATHS } from "../review-context-files.js"
import { ReviewContext, useReview } from "../review-context.js"
import type { ReviewFinding, StagedReviewFinding } from "../../lib/review-queue.js"
import { createReviewAuditTools } from "../../tools/review.js"

const MAX_REVIEW_FINDINGS = 24

export type AuditedReview = {
  findings: ReviewFinding[]
}

function AuditAgent({ findings }: { findings: readonly StagedReviewFinding[] }) {
  const review = useReview()
  const tools = createReviewAuditTools(review.queue, findings)

  return (
    <Agent
      name="review-audit"
      permissions={{ filesystem: "read-only", network: false, shell: false }}
      system="You calibrate pull-request findings already staged by specialists. You never perform another review or rewrite author text or evidence."
    >
      <Skill name="Review audit policy" src="./skills/audit.md" />
      <Tool use={tools.mergeReviewFindings} />
      <Tool use={tools.demoteReviewFinding} />
      <Tool use={tools.dropReviewFindings} />
      {`Consolidate the staged findings below into the review that should reach the author.

${JSON.stringify({ staged_findings: findings }, null, 2)}

You may read only ${REVIEW_CONTEXT_PATHS.pullRequest} for the author's stated intent and ${REVIEW_CONTEXT_PATHS.history} for accepted decisions, prior feedback, or existing threads. Use them only to decide whether a staged finding remains relevant.

If more than ${MAX_REVIEW_FINDINGS} findings would remain, drop the least useful until the hard safety ceiling is met; the ceiling is never a target.`}
    </Agent>
  )
}

/** Funnels staged lane findings through audit's constrained calibration queue. */
export async function ReviewAudit({ children }: { children: AmlRenderable }) {
  const review = useReview()
  const staged = review.queue.staged()
  const candidates = review.queue.beginAudit()

  if (staged.length > 0) {
    await evaluate(<AuditAgent findings={candidates} />)
  }
  const findings = review.queue.audited()
  if (findings.length > MAX_REVIEW_FINDINGS) {
    throw new Error(`review audit retained ${findings.length} findings; hard safety ceiling is ${MAX_REVIEW_FINDINGS}`)
  }

  return <ReviewContext.Provider value={{ ...review, audit: { findings } }}>{children}</ReviewContext.Provider>
}
