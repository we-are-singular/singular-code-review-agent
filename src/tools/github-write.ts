import { defineTool, type AmlJsonValue } from "@aml-jsx/sdk"
import { z } from "zod"

import type { ReviewPayload } from "../lib/review-body.js"
import type { ReviewReply } from "../lib/review-queue.js"
import type { GitHubActions } from "../services/github-actions.js"

export type ReviewPublicationPlan =
  | { kind: "review"; prNumber: number; payload: ReviewPayload; replies: ReviewReply[] }
  | { kind: "issue-comment"; prNumber: number; body: string }

/** AML Tools must return a JSON snapshot rather than mutable Octokit objects. */
function json(value: unknown): AmlJsonValue {
  return JSON.parse(JSON.stringify(value)) as AmlJsonValue
}

/**
 * Creates mutation Tools closed over one validated plan. The publication
 * component owns ordering and cannot alter comment bodies, anchors, or targets.
 */
export function createGitHubWriteTools(actions: GitHubActions, plan: ReviewPublicationPlan) {
  return {
    postIssueComment: defineTool({
      name: "post_issue_comment",
      description: "Post the exact prepared gate answer to the active pull request",
      input: z.object({}).strict(),
      execute: async () => {
        if (plan.kind !== "issue-comment") {
          throw new Error("this review has no prepared issue comment")
        }
        return json(await actions.postIssueComment(plan.prNumber, plan.body))
      }
    }),
    submitPullRequestReview: defineTool({
      name: "submit_pull_request_review",
      description: "Submit the exact validated pull-request review and inline comments",
      input: z.object({}).strict(),
      execute: async () => {
        if (plan.kind !== "review") {
          throw new Error("this run has no prepared pull-request review")
        }
        return json(await actions.submitPullRequestReview(plan.prNumber, plan.payload))
      }
    }),
    replyToReviewComment: defineTool({
      name: "reply_to_review_comment",
      description: "Post one exact validated reply selected by its zero-based plan index",
      input: z.object({ index: z.number().int().nonnegative() }).strict(),
      execute: async ({ index }) => {
        if (plan.kind !== "review") {
          throw new Error("this run has no prepared review-comment replies")
        }
        const reply = plan.replies[index]
        if (!reply) {
          throw new Error(`reply index ${index} is outside the prepared plan`)
        }
        return json(await actions.replyToReviewComment(plan.prNumber, reply.to, reply.body))
      }
    })
  }
}
