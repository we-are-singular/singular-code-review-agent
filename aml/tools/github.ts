import { defineTool, type AmlJsonValue } from "@aml-jsx/sdk"
import { z } from "zod"

import type { ReviewPayload, ReviewReply } from "../../src/review/types.js"
import type { GitHubActions } from "../services/github-actions.js"
import type { GitHubReviewSession } from "../services/github-session.js"

export type ReviewPublicationPlan =
  | { kind: "review"; prNumber: number; payload: ReviewPayload; replies: ReviewReply[] }
  | { kind: "issue-comment"; prNumber: number; body: string }

/** AML Tools must return a JSON snapshot rather than mutable Octokit objects. */
function json(value: unknown): AmlJsonValue {
  return JSON.parse(JSON.stringify(value)) as AmlJsonValue
}

/** Defines the complete read-only GitHub surface for the active pull request. */
export function createGitHubReadTools(session: GitHubReviewSession) {
  return {
    getPullRequest: defineTool({
      name: "get_pull_request",
      description: "Read metadata for the active pull request",
      input: z.object({}).strict(),
      execute: async () => json(await session.getPullRequest())
    }),
    getPullRequestDiff: defineTool({
      name: "get_pull_request_diff",
      description: "Read the filtered unified diff as plain text",
      input: z.object({}).strict(),
      // A plain diff avoids making coding agents decode one enormous JSON
      // string. Ignored-file metadata already travels in reviewerContext.
      execute: async () => (await session.getPullRequestDiff()).text
    }),
    getIssueComment: defineTool({
      name: "get_issue_comment",
      description: "Read one issue or pull-request conversation comment by GitHub id",
      input: z.object({ commentId: z.number().int().positive() }).strict(),
      execute: async ({ commentId }) => json(await session.getIssueComment(commentId))
    }),
    listIssueComments: defineTool({
      name: "list_issue_comments",
      description: "List pull-request conversation comments in chronological API order",
      input: z.object({}).strict(),
      execute: async () => json(await session.listIssueComments())
    }),
    listReviewComments: defineTool({
      name: "list_review_comments",
      description: "List inline review comments, including reply relationships",
      input: z.object({}).strict(),
      execute: async () => json(await session.listReviewComments())
    }),
    listReviews: defineTool({
      name: "list_reviews",
      description: "List submitted pull-request reviews and their commit anchors",
      input: z.object({}).strict(),
      execute: async () => json(await session.listReviews())
    }),
    listPullRequestCommits: defineTool({
      name: "list_pull_request_commits",
      description: "List commits currently contained in the pull request",
      input: z.object({}).strict(),
      execute: async () => json(await session.listPullRequestCommits())
    }),
    listReviewThreads: defineTool({
      name: "list_review_threads",
      description: "List review threads with resolved and outdated state when GitHub exposes it",
      input: z.object({}).strict(),
      execute: async () => json(await session.listReviewThreads())
    }),
    listIssueCommentReactions: defineTool({
      name: "list_issue_comment_reactions",
      description: "List reactions on one issue or pull-request conversation comment",
      input: z.object({ commentId: z.number().int().positive() }).strict(),
      execute: async ({ commentId }) => json(await session.listIssueCommentReactions(commentId))
    })
  }
}

/** The acknowledgement capability is scoped to the triggering comment only. */
export function createReactionTool(actions: GitHubActions, commentId: number) {
  return defineTool({
    name: "react_to_issue_comment",
    description: "Acknowledge the triggering review request with an eyes reaction",
    input: z.object({}).strict(),
    execute: async () => json(await actions.reactToIssueComment(commentId))
  })
}

/**
 * Creates mutation Tools closed over one validated plan. The publication
 * component owns ordering and cannot alter comment bodies, anchors, or targets.
 */
export function createGitHubPublicationTools(actions: GitHubActions, plan: ReviewPublicationPlan) {
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
