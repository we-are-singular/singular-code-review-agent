import {
  type ReviewInlineComment,
  type ReviewPayload,
  type ReviewPayloadComment,
  type ValidatedReviewQueue,
} from "./types.js";

const MAX_REVIEW_BODY_LENGTH = 6_000;

/**
 * Converts provider-qualified model ids into the compact label shown in the
 * programmatic review banner.
 */
export function modelLabel(modelId: string): string {
  return modelId.split("/").filter(Boolean).pop() || modelId || "unknown";
}

/**
 * Adds the runner-owned model banner exactly once from the runner perspective.
 * The function deliberately does not sanitize model output that includes a
 * banner, because the synthesis prompt owns that output contract.
 */
export function applyReviewBanner(body: string, modelId: string): string {
  const trimmed = body.trim();
  const banner = `> reviewer · ${modelLabel(modelId)}`;
  return trimmed ? `${banner}\n\n${trimmed}` : banner;
}

/**
 * Keeps the top-level review body within a conservative size limit while
 * preserving the inline comments as the source of detailed findings.
 */
export function enforceReviewBodyLimit(body: string, maxLength = MAX_REVIEW_BODY_LENGTH): string {
  if (body.length <= maxLength) {
    return body;
  }

  return `${body.slice(0, maxLength).trimEnd()}\n\n[Review body truncated]`;
}

/**
 * Maps the validated queue shape to GitHub's pull-request review comment shape.
 */
export function toReviewPayloadComment(comment: ReviewInlineComment): ReviewPayloadComment {
  const payload: ReviewPayloadComment = {
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: comment.body,
  };

  if (comment.start_line !== undefined) {
    payload.start_line = comment.start_line;
    payload.start_side = comment.start_side || comment.side;
  }

  return payload;
}

/**
 * Builds the single batched review payload submitted after all queue validation
 * and synthesis phases have completed.
 */
export function buildReviewPayload(validated: ValidatedReviewQueue): ReviewPayload {
  return {
    body: validated.conclusion?.trim() || "Singular Code Review completed.",
    event: "COMMENT",
    comments: validated.inlineComments.map(toReviewPayloadComment),
  };
}
