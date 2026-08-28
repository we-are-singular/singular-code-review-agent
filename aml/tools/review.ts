import { defineTool } from "@aml-jsx/sdk"
import { z } from "zod"

import {
  InlineFindingSchema,
  ReviewBlockerSchema,
  ReplyFindingSchema,
  type ReviewFindings,
  type ReviewLaneName
} from "../services/review-findings.js"

const CommentInputSchema = InlineFindingSchema.omit({ kind: true, comment_type: true }).extend({
  kind: z.literal("comment")
})

const SuggestionInputSchema = InlineFindingSchema.omit({
  kind: true,
  comment_type: true,
  body: true,
  side: true,
  start_side: true
})
  .extend({
    kind: z.literal("suggestion"),
    message: z.string().trim().min(1).max(1_400).describe("Why the replacement is needed"),
    replacement: z.string().min(1).max(10_000).describe("Complete replacement for the selected added lines")
  })
  .strict()

// OpenCode advertises MCP Tools as provider function calls, whose input schema
// must be a top-level object. Keep discovery flat, then enforce the exact
// comment or suggestion contract inside execute before any finding is staged.
const AddReviewCommentSchema = InlineFindingSchema.omit({
  kind: true,
  comment_type: true,
  body: true,
  side: true,
  start_side: true
})
  .extend({
    kind: z.enum(["comment", "suggestion"]),
    body: CommentInputSchema.shape.body.optional().describe("Required author-facing explanation for a comment"),
    message: SuggestionInputSchema.shape.message.optional().describe("Required explanation for a suggestion"),
    replacement: SuggestionInputSchema.shape.replacement
      .optional()
      .describe("Required complete suggestion replacement"),
    side: CommentInputSchema.shape.side.optional().describe("Required diff side for a comment; suggestions use RIGHT"),
    start_side: CommentInputSchema.shape.start_side
      .optional()
      .describe("Optional start diff side for a multiline comment")
  })
  .strict()
const AddReviewReplySchema = ReplyFindingSchema.omit({ kind: true })
const AddReviewBlockerSchema = ReviewBlockerSchema.omit({ kind: true, severity: true, confidence: true })

/** Grants one lane its complete in-memory review surface. */
export function createReviewTools(review: ReviewFindings, lane: ReviewLaneName) {
  return {
    addReviewComment: defineTool({
      name: "add_review_comment",
      description: "Queue one evidence-backed inline comment or complete suggestion for audit",
      input: AddReviewCommentSchema,
      execute: rawInput => {
        if (rawInput.kind === "suggestion") {
          const input = SuggestionInputSchema.parse(rawInput)
          const { kind: _kind, message, replacement, ...finding } = input
          const replacementText = replacement.trimEnd()
          if (!replacementText) {
            throw new Error("review suggestion replacement must contain non-whitespace text")
          }
          const result = review.add(lane, {
            kind: "inline",
            comment_type: "suggestion",
            ...finding,
            body: `${message}\n\n\`\`\`suggestion\n${replacementText}\n\`\`\``,
            side: "RIGHT",
            ...(finding.start_line === undefined ? {} : { start_side: "RIGHT" })
          })
          return { status: result.duplicate ? "already_queued" : "queued" }
        }

        const input = CommentInputSchema.parse(rawInput)
        const { kind: _kind, ...finding } = input
        const result = review.add(lane, { kind: "inline", ...finding })
        return { status: result.duplicate ? "already_queued" : "queued" }
      }
    }),
    addReviewReply: defineTool({
      name: "add_review_reply",
      description: "Queue one evidence-backed response to an existing top-level review comment",
      input: AddReviewReplySchema,
      execute: finding => {
        const result = review.add(lane, { kind: "reply", ...finding })
        return { status: result.duplicate ? "already_queued" : "queued" }
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
        return { status: result.duplicate ? "already_queued" : "queued" }
      }
    })
  }
}
