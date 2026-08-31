import { createContext, useContext } from "@aml-jsx/sdk"

import type { PublishedReview, ReviewSnapshot } from "../types/review.js"
import type { ReviewQueue } from "../lib/review-queue.js"
import type { ReviewGitHubActions } from "../services/github-actions.js"
import type { GitHubReviewSession } from "../services/github-session.js"
import type { ReviewGateResult } from "./phases/review-gate.js"

/** Owns the one deterministic publication outcome returned to the runtime. */
export class ReviewOutcome {
  #published: PublishedReview | undefined
  #publicationError: string | null = null

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

/** Request-scoped dependencies and route state for one reviewed PR head. */
export type ReviewContextValue = {
  github: GitHubReviewSession
  actions: ReviewGitHubActions
  queue: ReviewQueue
  outcome: ReviewOutcome
  snapshot: ReviewSnapshot
  model: string
  gate?: ReviewGateResult
}

export const ReviewContext = createContext<ReviewContextValue>("SingularReview")

/** Reads the single request-scoped dependency and phase-result context. */
export function useReviewContext(): ReviewContextValue {
  return useContext(ReviewContext)
}
