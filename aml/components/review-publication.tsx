import { applyReviewBanner, buildReviewPayload, enforceReviewBodyLimit } from "../../src/review/body.js"
import { useReview } from "../review-context.js"
import type { PublicationExpectation } from "../services/github-actions.js"
import { createGitHubPublicationTools, type ReviewPublicationPlan } from "../tools/github.js"
import type { PublishedReview } from "../review-result.js"

/** Publishes the selected draft through application-invoked, traced AML Tools. */
export async function ReviewPublication() {
  const { actions, github, model, outcome } = useReview()
  const draft = outcome.selected()
  let published: PublishedReview
  let plan: ReviewPublicationPlan
  let expectation: PublicationExpectation

  if (draft.status === "reviewed") {
    const body = enforceReviewBodyLimit(applyReviewBanner(draft.body, model))
    const validated = { ...draft.validated, conclusion: body }
    const payload = buildReviewPayload(validated)
    published = { ...draft, body, validated, payload }
    plan = { kind: "review", prNumber: github.request.prNumber, payload, replies: validated.replies }
    expectation = { kind: "review", replies: validated.replies.length }
  } else {
    published = draft
    plan = { kind: "issue-comment", prNumber: github.request.prNumber, body: draft.body }
    expectation = { kind: "issue-comment" }
  }

  const tools = createGitHubPublicationTools(actions, plan)
  let publicationError: string | null = null

  try {
    // Validation anchors belong to one immutable head. Re-review instead of
    // publishing comments prepared for a commit GitHub has already replaced.
    await github.assertHeadUnchanged()
    if (plan.kind === "issue-comment") {
      await tools.postIssueComment({})
    } else {
      await tools.submitPullRequestReview({})
      for (const [index] of plan.replies.entries()) {
        await tools.replyToReviewComment({ index })
      }
    }
  } catch (error) {
    // A rejected POST may have reached GitHub. The action ledger decides
    // whether completion is proven; ambiguous mutations are never replayed.
    const message = error instanceof Error ? error.message : String(error)
    const state = actions.publicationState(expectation)
    if (state === "ambiguous") {
      publicationError = `GitHub mutation outcome is ambiguous; publication was not replayed: ${message}`
    } else if (state !== "completed") {
      publicationError = `GitHub publication failed before completion: ${message}`
    }
  }

  if (!publicationError && actions.publicationState(expectation) !== "completed") {
    publicationError = "GitHub publisher finished without completing every prepared mutation"
  }
  outcome.publish(published, publicationError)
  return ""
}
