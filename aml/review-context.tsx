import { createContext, useContext } from "@aml-jsx/sdk"

import type { ValidatedReview } from "./phases/review-validation.js"
import type { ReviewGitHubActions } from "./services/github-actions.js"
import type { GitHubReviewSession } from "./services/github-session.js"
import type { ReviewFindings } from "./services/review-findings.js"
import type { AuditedReview } from "./phases/review-audit.js"
import type { ReviewGateResult } from "./phases/review-gate.js"
import type { PublishedReview, ReviewDraft, ReviewSnapshot } from "./review-result.js"

/** Owns the one selected draft and its deterministic publication outcome. */
export class ReviewOutcome {
  #draft: ReviewDraft | undefined
  #published: PublishedReview | undefined
  #publicationError: string | null = null

  select(draft: ReviewDraft): void {
    if (this.#draft) {
      throw new Error("the review already selected a draft")
    }
    this.#draft = structuredClone(draft)
  }

  selected(): ReviewDraft {
    if (!this.#draft) {
      throw new Error("the review finished without selecting a draft")
    }
    return structuredClone(this.#draft)
  }

  publish(review: PublishedReview, error: string | null): void {
    if (this.#published) {
      throw new Error("the review publication outcome is already complete")
    }
    this.#published = structuredClone(review)
    this.#publicationError = error
  }

  result(): { review: PublishedReview; publicationError: string | null } {
    if (!this.#published) {
      throw new Error("the review finished without a publication outcome")
    }
    return { review: structuredClone(this.#published), publicationError: this.#publicationError }
  }
}

/** Request-scoped dependencies and typed phase results for one reviewed PR head. */
export type ReviewContextValue = {
  github: GitHubReviewSession
  actions: ReviewGitHubActions
  findings: ReviewFindings
  outcome: ReviewOutcome
  snapshot: ReviewSnapshot
  model: string
  gate?: Extract<ReviewGateResult, { decision: "review" }>
  audit?: AuditedReview
  validated?: ValidatedReview
}

export const ReviewContext = createContext<ReviewContextValue>("SingularReview")

export function useReview(): ReviewContextValue {
  return useContext(ReviewContext)
}
