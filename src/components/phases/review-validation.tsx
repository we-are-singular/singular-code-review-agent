import { evaluate, type AmlRenderable } from "@aml-jsx/sdk"

import type { FinalizedReview } from "../../lib/review-queue.js"
import { useReviewContext } from "../review-context.js"

export type ValidatedReview = FinalizedReview

/** Resolves audit, records its structured results in Context, then hands its text to synthesis. */
export async function ReviewValidation({ children }: { children: AmlRenderable }) {
  const review = useReviewContext()
  const auditHandoff = await evaluate(children)

  review.audit = { findings: review.queue.audited() }
  review.validated = review.queue.finalize()
  return auditHandoff
}
