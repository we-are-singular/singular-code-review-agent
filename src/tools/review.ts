import { defineTool, type AmlJsonValue } from "@aml-jsx/sdk"
import { z } from "zod"

import {
  InlineFindingSchema,
  ReviewDemotionSeveritySchema,
  ReviewBlockerSchema,
  ReplyFindingSchema,
  type ReviewFinding,
  type ReviewQueue,
  type ReviewLaneName,
  type StagedReviewFinding
} from "../lib/review-queue.js"
import type { ReviewSnapshot } from "../types/review.js"

const ReviewLineSchema = z
  .union([z.number().int().positive(), z.string().trim().min(1), z.array(z.number().int().positive()).min(1)])
  .describe('One changed line or an inclusive range, such as 42, "40-42", "L40-L42", or [40, 42]')

const AddReviewCommentSchema = InlineFindingSchema.omit({
  kind: true,
  comment_type: true,
  line: true,
  start_line: true,
  start_side: true
})
  .extend({ line: ReviewLineSchema })
  .strict()
const AddReviewReplySchema = ReplyFindingSchema.omit({ kind: true, to: true })
  .extend({ comment_id: ReplyFindingSchema.shape.to })
  .strict()
const AddReviewBlockerSchema = ReviewBlockerSchema.omit({ kind: true, severity: true, confidence: true })
const FullCommentSchema = z
  .object({
    kind: z.enum(["issue_comment", "review_comment", "review"]),
    id: z.number().int().positive()
  })
  .strict()

/** Converts forgiving Agent line notation into GitHub's terminal line and optional same-side range start. */
function normalizeReviewLine(value: z.infer<typeof ReviewLineSchema>): { line: number; start_line?: number } {
  let lines: number[]
  if (typeof value === "number") {
    lines = [value]
  } else if (typeof value === "string") {
    lines = Array.from(value.matchAll(/\d+/gu), match => Number(match[0]))
  } else {
    lines = value
  }
  if (lines.length === 0 || lines.some(line => !Number.isSafeInteger(line) || line <= 0)) {
    throw new Error("review line must contain at least one positive integer")
  }

  const start = Math.min(...lines)
  const end = Math.max(...lines)
  if (start === end) {
    return { line: end }
  }
  return { line: end, start_line: start }
}

/** Grants one lane its complete in-memory review surface. */
export function createReviewTools(review: ReviewQueue, lane: ReviewLaneName) {
  return {
    addReviewComment: defineTool({
      name: "add_review_comment",
      description: "Queue one evidence-backed GitHub review comment for audit",
      input: AddReviewCommentSchema,
      execute: input => {
        const { line, ...finding } = input
        const range = normalizeReviewLine(line)
        const comment: Extract<ReviewFinding, { kind: "inline" }> = {
          kind: "inline",
          ...finding,
          ...range
        }
        // Suggestions remain ordinary review bodies; the kind exists only for
        // queue identity and diagnostics after the Tool call.
        if (input.body.includes("```suggestion")) {
          comment.comment_type = "suggestion"
        }
        if (range.start_line !== undefined) {
          comment.start_side = input.side
        }
        const result = review.add(lane, comment)
        return { id: result.id }
      }
    }),
    addReviewReply: defineTool({
      name: "add_review_reply",
      description: "Queue one direct response to an existing top-level GitHub review comment",
      input: AddReviewReplySchema,
      execute: ({ comment_id, ...finding }) => {
        const result = review.add(lane, { kind: "reply", to: comment_id, ...finding })
        return { id: result.id }
      }
    }),
    addReviewBlocker: defineTool({
      name: "add_review_blocker",
      description: "Queue one high-confidence critical blocker that has no honest changed-line anchor",
      input: AddReviewBlockerSchema,
      execute: finding => {
        const result = review.add(lane, {
          ...finding,
          kind: "blocker",
          severity: "critical",
          confidence: "high"
        })
        return { id: result.id }
      }
    })
  }
}

/** Grants audit its complete calibration surface over staged findings. */
export function createReviewAuditTools(
  review: ReviewQueue,
  candidates: readonly StagedReviewFinding[],
  snapshot: ReviewSnapshot
) {
  if (candidates.length === 0) {
    throw new Error("review audit tools require at least one staged finding")
  }

  const findingId = z.enum(candidates.map(candidate => candidate.id) as [string, ...string[]])
  return {
    mergeReviewFindings: defineTool({
      name: "merge_review_findings",
      description: "Keep one staged finding and remove only the listed semantic duplicates",
      input: z
        .object({
          keep: findingId.describe("ID of the strongest author-ready finding to keep unchanged"),
          duplicates: z.array(findingId).min(1).describe("IDs of equivalent findings to remove")
        })
        .strict(),
      execute: ({ keep, duplicates }) => {
        review.merge(keep, duplicates)
        return { ok: true }
      }
    }),
    demoteReviewFinding: defineTool({
      name: "demote_review_finding",
      description: "Lower one anchored inline finding's severity without changing its text or evidence",
      input: z
        .object({
          id: findingId.describe("Exact ID of the finding to demote"),
          severity: ReviewDemotionSeveritySchema.optional().describe(
            "Explicit lower severity; omit to move one step, with an existing nit dropping from the queue"
          )
        })
        .strict(),
      execute: ({ id, severity }) => review.demote(id, severity)
    }),
    dropReviewFindings: defineTool({
      name: "drop_review_findings",
      description: "Remove staged findings that should not reach the pull-request author",
      input: z.object({ ids: z.array(findingId).min(1).describe("Exact IDs of findings to remove") }).strict(),
      execute: ({ ids }) => {
        review.drop(ids)
        return { ok: true }
      }
    }),
    getFullComment: defineTool({
      name: "get_full_comment",
      description:
        "Read one complete captured comment or review; review comments include their surrounding thread when present",
      input: FullCommentSchema,
      execute: ({ kind, id }): AmlJsonValue => {
        if (kind === "issue_comment") {
          const comment = snapshot.issueComments.find(candidate => candidate.id === id)
          if (!comment) throw new Error(`issue comment #${id} is not present in the captured history`)
          return {
            kind,
            id,
            actor: comment.user?.login || null,
            created_at: comment.created_at || null,
            updated_at: comment.updated_at || null,
            body: comment.body || "",
            url: comment.html_url || null
          }
        }

        if (kind === "review") {
          const capturedReview = snapshot.reviews.find(candidate => candidate.id === id)
          if (!capturedReview) throw new Error(`review #${id} is not present in the captured history`)
          return {
            kind,
            id,
            actor: capturedReview.user?.login || null,
            submitted_at: capturedReview.submitted_at || capturedReview.submittedAt || null,
            state: capturedReview.state || null,
            commit_id: capturedReview.commit_id || capturedReview.commitId || null,
            body: capturedReview.body || "",
            url: capturedReview.html_url || capturedReview.url || null
          }
        }

        const thread = snapshot.reviewThreads.find(candidate => candidate.comments.some(comment => comment.id === id))
        const comment =
          thread?.comments.find(candidate => candidate.id === id) ||
          snapshot.reviewComments.find(candidate => candidate.id === id)
        if (!comment) throw new Error(`review comment #${id} is not present in the captured history`)
        return {
          kind,
          id,
          actor: comment.user?.login || null,
          created_at: comment.created_at || null,
          body: comment.body || "",
          url: comment.html_url || null,
          path: comment.path || thread?.path || null,
          start_line: comment.start_line || thread?.start_line || null,
          line: comment.line || thread?.line || null,
          thread: thread
            ? {
                id: thread.id,
                state: thread.is_resolved ? "resolved" : thread.is_outdated ? "outdated" : "unresolved",
                path: thread.path || null,
                start_line: thread.start_line || null,
                line: thread.line || null,
                comments: thread.comments.map(candidate => ({
                  id: candidate.id,
                  actor: candidate.user.login || null,
                  created_at: candidate.created_at || null,
                  body: candidate.body || "",
                  url: candidate.html_url || null
                }))
              }
            : null
        }
      }
    })
  }
}
