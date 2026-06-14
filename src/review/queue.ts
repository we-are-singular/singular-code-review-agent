import { isAbsolute } from "node:path";
import { readJsonFile, writeJsonFile } from "../lib/json.js";
import {
  type DroppedQueueItem,
  type ReviewContext,
  type ReviewInlineComment,
  type ReviewInlineCommentInput,
  type ReviewQueue,
  type ReviewReply,
  type ReviewReplyInput,
  type ReviewSide,
  type ReviewThread,
  type ValidatedReviewQueue,
} from "./types.js";

/**
 * Creates the canonical queue shape shared by the agent-facing CLI and runner.
 */
export function createEmptyQueue(): ReviewQueue {
  return {
    version: 1,
    inlineComments: [],
    replies: [],
    conclusion: null,
    dropped: [],
    updatedAt: new Date().toISOString(),
  };
}

export function loadQueue(file: string): ReviewQueue {
  const value = readJsonFile<unknown>(file, createEmptyQueue());

  if (Array.isArray(value)) {
    // Older queue artifacts were bare arrays of inline comments. Keeping this
    // tolerant read path lets old dry-run artifacts remain inspectable.
    return {
      ...createEmptyQueue(),
      inlineComments: value as ReviewInlineCommentInput[],
    };
  }

  const partial = value && typeof value === "object" ? (value as Partial<ReviewQueue>) : {};
  return {
    ...createEmptyQueue(),
    ...partial,
    inlineComments: Array.isArray(partial.inlineComments) ? partial.inlineComments : [],
    replies: Array.isArray(partial.replies) ? partial.replies : [],
    conclusion: typeof partial.conclusion === "string" ? partial.conclusion : null,
    dropped: Array.isArray(partial.dropped) ? partial.dropped : [],
  };
}

export function saveQueue(file: string, queue: ReviewQueue): void {
  writeJsonFile(file, {
    ...queue,
    updatedAt: new Date().toISOString(),
  });
}

export function clearQueue(file: string): ReviewQueue {
  const queue = createEmptyQueue();
  saveQueue(file, queue);
  return queue;
}

export function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function validateRepoPath(reviewPath: unknown): asserts reviewPath is string {
  if (!reviewPath || typeof reviewPath !== "string" || reviewPath.includes("\0")) {
    throw new Error("path must be a non-empty repository-relative path");
  }

  if (isAbsolute(reviewPath)) {
    throw new Error("path must be repository-relative, not absolute");
  }
}

function normalizeSide(value: unknown, name: string): ReviewSide {
  const side = String(value || "RIGHT").toUpperCase();
  if (side !== "LEFT" && side !== "RIGHT") {
    throw new Error(`${name} must be LEFT or RIGHT`);
  }
  return side;
}

/**
 * Normalizes agent-provided inline comment input into the GitHub review comment
 * contract before any diff-aware validation happens.
 */
export function normalizeInlineComment(input: ReviewInlineCommentInput): ReviewInlineComment {
  validateRepoPath(input.path);
  const line = positiveInteger(input.line, "line");
  const startLine = input.start_line === undefined ? undefined : positiveInteger(input.start_line, "start-line");
  const side = normalizeSide(input.side, "side");
  const startSide = input.start_side === undefined ? side : normalizeSide(input.start_side, "start-side");
  const body = String(input.body || "").trim();

  if (!body) {
    throw new Error("body must be non-empty");
  }

  if (startLine !== undefined && startSide === side && startLine > line) {
    throw new Error("start-line must be less than or equal to line");
  }

  const comment: ReviewInlineComment = {
    kind: input.kind || "comment",
    path: input.path,
    line,
    side,
    body,
  };

  if (startLine !== undefined && (startLine !== line || startSide !== side)) {
    comment.start_line = startLine;
    comment.start_side = startSide;
  }

  return comment;
}

export function addInlineComment(file: string, input: ReviewInlineCommentInput): ReviewInlineComment {
  const queue = loadQueue(file);
  const comment = normalizeInlineComment(input);
  queue.inlineComments.push(comment);
  saveQueue(file, queue);
  return comment;
}

/**
 * Stores a GitHub suggestion as an ordinary inline comment body containing a
 * fenced suggestion block, which keeps payload creation simple later.
 */
export function addSuggestion(
  file: string,
  input: Omit<ReviewInlineCommentInput, "body"> & { message: string; replacement: string },
): ReviewInlineComment {
  const message = String(input.message || "").trim();
  const replacement = String(input.replacement || "").replace(/\s+$/u, "");

  if (!message) {
    throw new Error("message must be non-empty");
  }

  if (!replacement) {
    throw new Error("replacement must be non-empty");
  }

  if (replacement.length > 10_000) {
    throw new Error("replacement is too large");
  }

  return addInlineComment(file, {
    ...input,
    kind: "suggestion",
    body: `${message}\n\n\`\`\`suggestion\n${replacement}\n\`\`\``,
  });
}

export function normalizeReply(input: ReviewReplyInput): ReviewReply {
  const to = positiveInteger(input.to || input.comment_id, "to");
  const body = String(input.body || "").trim();

  if (!body) {
    throw new Error("body must be non-empty");
  }

  return { to, body };
}

export function addReply(file: string, input: ReviewReplyInput): ReviewReply {
  const reply = normalizeReply(input);
  const queue = loadQueue(file);
  queue.replies.push(reply);
  saveQueue(file, queue);
  return reply;
}

export function setConclusion(file: string, bodyInput: string): { body: string } {
  const body = String(bodyInput || "").trim();
  if (!body) {
    throw new Error("body must be non-empty");
  }

  if (body.length > 10_000) {
    throw new Error("body is too large");
  }

  const queue = loadQueue(file);
  queue.conclusion = body;
  saveQueue(file, queue);
  return { body };
}

function hasLine(lines: number[] | undefined, line: number): boolean {
  return Array.isArray(lines) && lines.includes(line);
}

function hasEveryLine(lines: number[] | undefined, startLine: number, endLine: number): boolean {
  if (!Array.isArray(lines)) {
    return false;
  }

  const set = new Set(lines);
  for (let line = startLine; line <= endLine; line += 1) {
    if (!set.has(line)) {
      return false;
    }
  }
  return true;
}

function commentKey(comment: ReviewInlineComment): string {
  return [
    comment.kind,
    comment.path,
    comment.start_line || "",
    comment.line,
    comment.side,
    comment.start_side || "",
    comment.body,
  ].join("\0");
}

function commentLocationKey(comment: ReviewInlineComment): string {
  return [comment.path, comment.start_line || "", comment.line, comment.side, comment.start_side || ""].join("\0");
}

function normalizeComparableBody(body: unknown): string {
  return String(body || "").replace(/\s+/gu, " ").trim();
}

function replyKey(reply: ReviewReply): string {
  return [reply.to, reply.body].join("\0");
}

function commentFromThread(thread: ReviewThread): ReviewInlineComment | null {
  const topLevel = thread.comments[0] || null;
  const pathValue = thread.path || topLevel?.path;
  const lineValue = thread.line || topLevel?.line;

  if (!pathValue || !lineValue) {
    return null;
  }

  const comment: ReviewInlineComment = {
    kind: "comment",
    path: pathValue,
    line: Number(lineValue),
    side: normalizeSide(thread.side || topLevel?.side, "side"),
    body: topLevel?.body || "",
  };

  const startLine = thread.start_line || topLevel?.start_line;
  const startSide = normalizeSide(thread.start_side || topLevel?.start_side || comment.side, "start-side");
  if (startLine && (Number(startLine) !== Number(lineValue) || startSide !== comment.side)) {
    comment.start_line = Number(startLine);
    comment.start_side = startSide;
  }

  return comment;
}

/**
 * Builds exact-match keys for already-posted bot findings so validation can
 * suppress duplicates without guessing about semantically similar comments.
 */
function existingBotFindingMatches(context: ReviewContext) {
  const botLogin = context.run?.bot_login;
  const matches = {
    unresolvedBodyKeys: new Set<string>(),
    restBodyKeys: new Set<string>(),
  };

  if (!botLogin) {
    return matches;
  }

  if (context.review_threads_available) {
    // Prefer unresolved thread state when available. A resolved previous bot
    // finding should not suppress a fresh finding on the same changed line.
    for (const thread of context.unresolved_bot_threads || []) {
      const comment = commentFromThread(thread);
      if (!comment) {
        continue;
      }
      matches.unresolvedBodyKeys.add(`${commentLocationKey(comment)}\0${normalizeComparableBody(comment.body)}`);
    }
    return matches;
  }

  // REST fallback has no reliable thread resolution state, so it is intentionally
  // narrower: only exact body/location matches to previous top-level bot comments.
  for (const comment of context.review_comments || []) {
    if (comment.user?.login !== botLogin || comment.in_reply_to_id) {
      continue;
    }

    const comparable: ReviewInlineComment = {
      kind: "comment",
      path: comment.path || "",
      line: Number(comment.line),
      side: normalizeSide(comment.side, "side"),
      body: comment.body || "",
    };
    const startLine = comment.start_line || comment.startLine;
    const startSide = normalizeSide(comment.start_side || comment.startSide || comparable.side, "start-side");
    if (startLine && (Number(startLine) !== Number(comment.line) || startSide !== comparable.side)) {
      comparable.start_line = Number(startLine);
      comparable.start_side = startSide;
    }

    matches.restBodyKeys.add(`${commentLocationKey(comparable)}\0${normalizeComparableBody(comparable.body)}`);
  }

  return matches;
}

/**
 * Validates one inline comment against the current PR diff. RIGHT comments must
 * target added lines; LEFT comments must target deleted lines.
 */
export function validateInlineComment(comment: ReviewInlineCommentInput, context: ReviewContext) {
  try {
    const normalized = normalizeInlineComment(comment);
    const ranges = context.valid_comment_ranges?.[normalized.path];
    if (!ranges) {
      return { ok: false as const, reason: "path is not present in the PR diff" };
    }

    const finalLines = normalized.side === "LEFT" ? ranges.deleted_lines : ranges.added_lines;
    if (!hasLine(finalLines, normalized.line)) {
      return { ok: false as const, reason: `line is not a changed ${normalized.side}-side line` };
    }

    if (normalized.start_line !== undefined) {
      const startSide = normalized.start_side || normalized.side;
      if (startSide === normalized.side) {
        // Same-side multi-line comments must cover a continuous range present
        // in the hunk so GitHub can anchor the whole comment.
        const rangeLines = normalized.side === "LEFT" ? ranges.left_lines : ranges.right_lines;
        if (!hasEveryLine(rangeLines, normalized.start_line, normalized.line)) {
          return { ok: false as const, reason: `multi-line range is not fully present on the ${normalized.side} side of the diff` };
        }
      } else {
        // Cross-side ranges are rare but valid for deletion/addition pairs; only
        // the starting side needs to exist because the final line was checked above.
        const startLines = startSide === "LEFT" ? ranges.left_lines : ranges.right_lines;
        if (!hasLine(startLines, normalized.start_line)) {
          return { ok: false as const, reason: `start line is not present on the ${startSide} side of the diff` };
        }
      }
    }

    return { ok: true as const, comment: normalized };
  } catch (error) {
    return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Validates that a queued reply targets a top-level review comment on this PR.
 */
export function validateReply(reply: ReviewReplyInput, context: ReviewContext) {
  try {
    const normalized = normalizeReply(reply);
    const comments = Array.isArray(context.review_comments) ? context.review_comments : [];
    const target = comments.find((comment) => Number(comment.id) === normalized.to);
    if (!target) {
      return { ok: false as const, reason: "reply target is not a review comment on this PR" };
    }

    if (target.in_reply_to_id) {
      return { ok: false as const, reason: "GitHub does not support replies to review-comment replies" };
    }

    return { ok: true as const, reply: normalized };
  } catch (error) {
    return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Applies all deterministic queue rules before GitHub submission. This function
 * may drop exact duplicates and invalid targets, but it intentionally keeps
 * distinct same-line findings for the audit phase and reviewer judgement.
 */
export function validateQueue(queue: ReviewQueue, context: ReviewContext): ValidatedReviewQueue {
  const inlineComments: ReviewInlineComment[] = [];
  const replies: ReviewReply[] = [];
  const dropped: DroppedQueueItem[] = [];
  const seenComments = new Set<string>();
  const seenReplies = new Set<string>();
  const existingBotMatches = existingBotFindingMatches(context);

  for (const original of queue.inlineComments || []) {
    const result = validateInlineComment(original, context);
    if (!result.ok) {
      dropped.push({ kind: "inline", item: original, reason: result.reason });
      continue;
    }

    const locationKey = commentLocationKey(result.comment);
    const bodyKey = `${locationKey}\0${normalizeComparableBody(result.comment.body)}`;
    if (existingBotMatches.unresolvedBodyKeys.has(bodyKey)) {
      // Thread-state duplicates are stronger than REST duplicates because they
      // only include unresolved bot threads.
      dropped.push({ kind: "inline", item: original, reason: "matching unresolved bot thread already exists" });
      continue;
    }

    if (existingBotMatches.restBodyKeys.has(bodyKey)) {
      dropped.push({ kind: "inline", item: original, reason: "matching previous bot comment already exists" });
      continue;
    }

    const key = commentKey(result.comment);
    if (seenComments.has(key)) {
      dropped.push({ kind: "inline", item: original, reason: "duplicate queued comment" });
      continue;
    }

    seenComments.add(key);
    inlineComments.push(result.comment);
  }

  for (const original of queue.replies || []) {
    const result = validateReply(original, context);
    if (!result.ok) {
      dropped.push({ kind: "reply", item: original, reason: result.reason });
      continue;
    }

    const key = replyKey(result.reply);
    if (seenReplies.has(key)) {
      dropped.push({ kind: "reply", item: original, reason: "duplicate queued reply" });
      continue;
    }

    seenReplies.add(key);
    replies.push(result.reply);
  }

  return {
    version: 1,
    inlineComments,
    replies,
    dropped,
    stats: {
      queued_inline: (queue.inlineComments || []).length,
      queued_replies: (queue.replies || []).length,
      has_conclusion: Boolean(queue.conclusion),
      valid_inline: inlineComments.length,
      valid_replies: replies.length,
      dropped: dropped.length,
    },
    conclusion: typeof queue.conclusion === "string" && queue.conclusion.trim() ? queue.conclusion.trim() : null,
  };
}

/**
 * Mirrors dropped validation results into the queue artifact so later phases and
 * dry-run users can understand what changed without re-running validation.
 */
export function persistValidation(queueFile: string, validated: ValidatedReviewQueue): void {
  const queue = loadQueue(queueFile);
  queue.dropped = validated.dropped;
  saveQueue(queueFile, queue);
}
