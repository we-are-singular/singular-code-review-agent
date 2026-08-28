import type { AmlRenderable } from "@aml-jsx/sdk"

import { normalizeInlineComment, normalizeReply, validateQueue } from "../../src/review/queue.js"
import type {
  ReviewInlineCommentInput,
  ReviewQueue,
  ReviewReplyInput,
  ValidatedReviewQueue
} from "../../src/review/types.js"
import { ReviewContext, useReview } from "../review-context.js"
import { authorComment, type ReviewFinding } from "../services/review-findings.js"

export type ValidatedReview = {
  queue: ValidatedReviewQueue
  findings: ReviewFinding[]
}

type ValidationEntry =
  | {
      finding: Extract<ReviewFinding, { kind: "inline" }>
      kind: "inline"
      input: ReviewInlineCommentInput
      key: string
    }
  | {
      finding: Extract<ReviewFinding, { kind: "reply" }>
      kind: "reply"
      input: ReviewReplyInput
      key: string
    }

/** Applies repository invariants while preserving typed metadata for retained findings. */
export function ReviewValidation({ children }: { children: AmlRenderable }) {
  const review = useReview()
  if (!review.audit) {
    throw new Error("ReviewValidation requires ReviewAudit")
  }

  const entries: ValidationEntry[] = []
  for (const finding of review.audit.findings) {
    if (finding.kind === "blocker") {
      continue
    }
    if (finding.kind === "inline") {
      const input: ReviewInlineCommentInput = {
        kind: finding.comment_type || "comment",
        path: finding.path,
        line: finding.line,
        side: finding.side,
        start_line: finding.start_line,
        start_side: finding.start_side,
        body: authorComment(finding)
      }
      entries.push({ finding, kind: "inline", input, key: JSON.stringify(normalizeInlineComment(input)) })
      continue
    }

    const input: ReviewReplyInput = { to: finding.to, body: authorComment(finding) }
    entries.push({ finding, kind: "reply", input, key: JSON.stringify(normalizeReply(input)) })
  }
  const queue: ReviewQueue = {
    version: 1,
    inlineComments: entries.flatMap(entry => (entry.kind === "inline" ? [entry.input] : [])),
    replies: entries.flatMap(entry => (entry.kind === "reply" ? [entry.input] : [])),
    conclusion: null,
    dropped: [],
    updatedAt: new Date().toISOString()
  }
  const validated = validateQueue(queue, review.snapshot.validationContext)

  // Validation can normalize and deduplicate comments. Match the surviving
  // GitHub payloads back to their typed finding without parsing rendered prose.
  const retained = new Map<string, number>()
  for (const comment of validated.inlineComments) {
    const key = JSON.stringify(comment)
    retained.set(key, (retained.get(key) || 0) + 1)
  }
  for (const reply of validated.replies) {
    const key = JSON.stringify(reply)
    retained.set(key, (retained.get(key) || 0) + 1)
  }
  const retainedFindings = new Set<ReviewFinding>()
  for (const entry of entries) {
    const count = retained.get(entry.key) || 0
    if (count > 0) {
      retained.set(entry.key, count - 1)
      retainedFindings.add(entry.finding)
    }
  }
  // Audit already calibrated blockers. They bypass only changed-line and
  // reply-target validation because their contract explicitly has no anchor.
  const findings = review.audit.findings.filter(finding => finding.kind === "blocker" || retainedFindings.has(finding))

  return (
    <ReviewContext.Provider value={{ ...review, validated: { queue: validated, findings } }}>
      {children}
    </ReviewContext.Provider>
  )
}
