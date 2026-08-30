import type { AmlRenderable } from "@aml-jsx/sdk"

import type { FinalizedReview } from "../../lib/review-queue.js"
import { ReviewContext, useReview } from "../review-context.js"

export type ValidatedReview = FinalizedReview

/** Freezes audit's active findings into the exact GitHub publication queue. */
export function ReviewValidation({ children }: { children: AmlRenderable }) {
  const review = useReview()
  if (!review.audit) {
    throw new Error("ReviewValidation requires ReviewAudit")
  }

  return (
    <ReviewContext.Provider value={{ ...review, validated: review.queue.finalize() }}>
      {children}
    </ReviewContext.Provider>
  )
}
