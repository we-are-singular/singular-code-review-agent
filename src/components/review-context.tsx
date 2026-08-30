import { createContext, useContext } from "@aml-jsx/sdk"

import type { PublishedReview, ReviewDraft, ReviewSnapshot } from "../types/review.js"
import type { ReviewQueue } from "../lib/review-queue.js"
import type { ReviewGitHubActions } from "../services/github-actions.js"
import type { GitHubReviewSession } from "../services/github-session.js"
import type { AuditedReview } from "./phases/review-audit.js"
import type { ReviewGateResult } from "./phases/review-gate.js"
import type { ValidatedReview } from "./phases/review-validation.js"

/** Owns the one selected draft and its deterministic publication outcome. */
export class ReviewOutcome {
  #draft: ReviewDraft | undefined
  #published: PublishedReview | undefined
  #publicationError: string | null = null

  /** Selects the only draft that publication may consume. */
  select(draft: ReviewDraft): void {
    if (this.#draft) {
      throw new Error("the review already selected a draft")
    }
    this.#draft = structuredClone(draft)
  }

  /** Reads the selected draft without exposing mutable phase state. */
  selected(): ReviewDraft {
    if (!this.#draft) {
      throw new Error("the review finished without selecting a draft")
    }
    return structuredClone(this.#draft)
  }

  /** Records the exact rendered review and its deterministic write outcome. */
  publish(review: PublishedReview, error: string | null): void {
    if (this.#published) {
      throw new Error("the review publication outcome is already complete")
    }
    this.#published = structuredClone(review)
    this.#publicationError = error
  }

  /** Returns the completed publication boundary to the runtime. */
  result(): { review: PublishedReview; publicationError: string | null } {
    if (!this.#published) {
      throw new Error("the review finished without a publication outcome")
    }
    return { review: structuredClone(this.#published), publicationError: this.#publicationError }
  }
}

/** Request-scoped dependencies and post-order phase results for one reviewed PR head. */
export type ReviewContextValue = {
  github: GitHubReviewSession
  actions: ReviewGitHubActions
  queue: ReviewQueue
  outcome: ReviewOutcome
  snapshot: ReviewSnapshot
  model: string
  gate?: Extract<ReviewGateResult, { decision: "review" }>
  audit?: AuditedReview
  validated?: ValidatedReview
}

export const ReviewContext = createContext<ReviewContextValue>("SingularReview")

/** Reads the single request-scoped dependency and phase-result context. */
export function useReviewContext(): ReviewContextValue {
  return useContext(ReviewContext)
}
