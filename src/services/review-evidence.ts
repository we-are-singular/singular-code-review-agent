import { readFileSync } from "node:fs"

import type {
  IssueComment,
  PullRequestCommit,
  PullRequestReview,
  PullRequestSummary,
  PullRequestTimelineEvent,
  ReviewComment,
  ReviewThread
} from "./github-client.js"
import type { ReviewActionItem, ReviewRequest, ReviewSnapshot, ReviewTimeline, ReviewTrigger } from "../types/review.js"
import type { ValidCommentRanges } from "../lib/review-diff.js"

export const REVIEW_COMMAND = "@singular-code-review"
export const DEFAULT_REVIEW_BOT_LOGIN = "singular-code-review[bot]"

// Preserve enough compact events for long-running PRs without allowing history to dominate the review context.
const HISTORY_ENTRY_LIMIT = 200
// Event bodies retain useful rationale and suggestions while staying cheaper than complete GitHub payloads.
const HISTORY_TEXT_LIMIT = 500
// Active requests need more room than historical events because the current run must answer them accurately.
const ACTION_TEXT_LIMIT = 1_600
// Comments, reviews, and commits come from richer dedicated reads; keep only non-duplicative lifecycle and scope events.
const INCLUDED_TIMELINE_EVENTS = new Set([
  "added_to_merge_queue",
  "assigned",
  "auto_merge_disabled",
  "auto_merge_enabled",
  "base_ref_changed",
  "closed",
  "convert_to_draft",
  "demilestoned",
  "head_ref_deleted",
  "head_ref_force_pushed",
  "head_ref_restored",
  "labeled",
  "locked",
  "merged",
  "milestoned",
  "ready_for_review",
  "removed_from_merge_queue",
  "renamed",
  "reopened",
  "review_dismissed",
  "review_request_removed",
  "review_requested",
  "unassigned",
  "unlabeled",
  "unlocked"
])

type GitHubEventPayload = {
  action?: string
  sender?: { login?: string | null } | null
  comment?: {
    id?: number
    body?: string | null
    user?: { login?: string | null } | null
  } | null
}

type ReviewEvidenceInput = {
  request: ReviewRequest
  trigger: ReviewTrigger
  pullRequest: PullRequestSummary
  diff: {
    text: string
    files: string[]
    ignoredFiles: string[]
    commentRanges: ValidCommentRanges
  }
  issueComments: IssueComment[]
  reviewComments: ReviewComment[]
  reviews: PullRequestReview[]
  timelineEvents?: PullRequestTimelineEvent[]
  commits: PullRequestCommit[]
  reviewThreadsAvailable: boolean
  reviewThreads: ReviewThread[]
}

/**
 * Converts cached GitHub responses into the one immutable evidence snapshot
 * shared by the AML tree, queue validation, and deterministic publication.
 */
export class ReviewEvidence {
  readonly #input: ReviewEvidenceInput

  constructor(input: ReviewEvidenceInput) {
    this.#input = input
  }

  /** Reads the GitHub Actions event once and reduces it to review routing data. */
  static trigger(request: Pick<ReviewRequest, "eventName" | "eventPath" | "actor">): ReviewTrigger {
    let payload: GitHubEventPayload = {}
    if (request.eventPath) {
      payload = JSON.parse(readFileSync(request.eventPath, "utf8")) as GitHubEventPayload
    }

    const eventName = request.eventName
    const action = payload.action
    let reason: ReviewTrigger["reason"] = "manual"
    if (eventName === "issue_comment") {
      reason = "mention"
    } else if (eventName === "pull_request" && action === "ready_for_review") {
      reason = "ready_for_review"
    } else if (eventName === "pull_request" && action === "opened") {
      reason = "opened"
    } else if (eventName === "pull_request" && action === "synchronize") {
      reason = "synchronize"
    } else if (eventName === "workflow_dispatch") {
      reason = "workflow_dispatch"
    }

    const eventComment = payload.comment
    return {
      eventName,
      reason,
      actor: request.actor || payload.sender?.login || null,
      comment:
        eventComment?.id && eventComment.id > 0
          ? {
              id: eventComment.id,
              author: eventComment.user?.login || null,
              body: ReviewEvidence.#compact(eventComment.body, ACTION_TEXT_LIMIT)
            }
          : null
    }
  }

  /** Builds all derived history once; no model-facing projection is maintained. */
  snapshot(): ReviewSnapshot {
    const unresolvedReviewThreads = this.#input.reviewThreads.filter(thread => !thread.is_resolved)
    const unresolvedBotThreads = unresolvedReviewThreads.filter(
      thread => thread.top_level_author === this.#input.request.botLogin
    )
    const actionItems = this.#actionItems()

    return Object.freeze({
      generatedAt: new Date().toISOString(),
      botLogin: this.#input.request.botLogin,
      command: REVIEW_COMMAND,
      trigger: this.#input.trigger,
      pullRequest: this.#input.pullRequest,
      diff: this.#input.diff,
      issueComments: this.#input.issueComments,
      reviewComments: this.#input.reviewComments,
      reviewThreadsAvailable: this.#input.reviewThreadsAvailable,
      reviewThreads: this.#input.reviewThreads,
      unresolvedReviewThreads,
      unresolvedBotThreads,
      reviews: this.#input.reviews,
      commits: this.#input.commits,
      timeline: this.#timeline(),
      previousBotFindings: this.#input.reviewComments.filter(
        comment => comment.user?.login === this.#input.request.botLogin && !comment.in_reply_to_id
      ),
      actionItems,
      participants: this.#participants(actionItems)
    })
  }

  /** Keeps history useful to models without copying full comments into summaries. */
  static #compact(value: unknown, limit: number): string {
    const text = String(value || "")
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/```suggestion\s*([\s\S]*?)```/giu, " suggestion: $1 ")
      .replace(/```[^\n]*\s*([\s\S]*?)```/gu, " code: $1 ")
      .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
      .replace(/\s+/gu, " ")
      .trim()
    const suffix = "… (truncated)"
    return text.length <= limit ? text : `${text.slice(0, limit - suffix.length).trimEnd()}${suffix}`
  }

  /** Produces the ordered, bounded timeline written to history.md. */
  #timeline(): ReviewTimeline {
    const entries: Array<{ at: string; text: string }> = []
    const location = (path?: string | null, start?: number | null, end?: number | null) => {
      if (!path) return null
      if (start && end && start !== end) return `${path}:${start}-${end}`
      return end || start ? `${path}:${end || start}` : path
    }

    const add = (entry: {
      at?: string | null
      kind: string
      ref?: string | number | null
      actor?: string | null
      state?: string | null
      location?: string | null
      body?: unknown
    }) => {
      const body = ReviewEvidence.#compact(entry.body, HISTORY_TEXT_LIMIT)
      const metadata = [
        entry.kind,
        entry.ref ? (entry.kind === "commit" ? String(entry.ref) : `#${entry.ref}`) : null,
        entry.actor ? `@${entry.actor}` : null,
        entry.state,
        entry.location
      ]
        .filter(Boolean)
        .join(" | ")
      entries.push({ at: entry.at || "", text: body ? `${metadata}\n> ${body}` : metadata })
    }

    for (const commit of this.#input.commits) {
      add({
        at: commit.commit?.committer?.date || commit.commit?.author?.date || "",
        kind: "commit",
        ref: commit.sha?.slice(0, 7),
        actor: commit.author?.login || commit.committer?.login,
        body: String(commit.commit?.message || "").split(/\r?\n/u)[0]
      })
    }

    const timelineEvents = this.#input.timelineEvents || []
    // A first ready event proves the PR opened as draft; a first draft conversion proves it opened ready.
    const firstDraftTransition = timelineEvents
      .filter(event => event.event === "convert_to_draft" || event.event === "ready_for_review")
      .sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")))[0]
    const initiallyDraft = firstDraftTransition
      ? firstDraftTransition.event === "ready_for_review"
      : Boolean(this.#input.pullRequest.isDraft ?? this.#input.pullRequest.draft)
    const createdAt = this.#input.pullRequest.createdAt || this.#input.pullRequest.created_at
    if (createdAt) {
      add({
        at: createdAt,
        kind: "pull request opened",
        actor: this.#input.pullRequest.author?.login || this.#input.pullRequest.user?.login,
        state: initiallyDraft ? "draft" : "ready"
      })
    }

    for (const event of timelineEvents) {
      if (!event.event || !INCLUDED_TIMELINE_EVENTS.has(event.event)) continue

      const subject =
        event.label?.name ||
        event.assignee?.login ||
        event.requested_reviewer?.login ||
        event.requested_team?.slug ||
        event.requested_team?.name ||
        event.commit_id?.slice(0, 7) ||
        (event.dismissed_review?.review_id ? `review #${event.dismissed_review.review_id}` : null)
      const body = event.rename
        ? `${event.rename.from || "unknown"} → ${event.rename.to || "unknown"}`
        : event.dismissed_review?.dismissal_message

      add({
        at: event.created_at,
        kind: event.event.replaceAll("_", " "),
        actor: event.actor?.login,
        state: subject,
        body
      })
    }

    for (const comment of this.#input.issueComments) {
      add({
        at: comment.created_at || comment.updated_at || "",
        kind: "issue comment",
        ref: comment.id,
        actor: comment.user?.login,
        state: comment.author_association,
        body: comment.body
      })
    }

    if (this.#input.reviewThreadsAvailable) {
      // GraphQL is the only source of resolved and outdated thread state, so prefer it over flat REST comments.
      for (const thread of this.#input.reviewThreads) {
        const state = thread.is_resolved ? "resolved" : thread.is_outdated ? "outdated" : "unresolved"
        for (const comment of thread.comments) {
          const path = comment.path || thread.path
          add({
            at: comment.created_at,
            kind: "review comment",
            ref: comment.id,
            actor: comment.user.login,
            state,
            location: location(path, comment.start_line || thread.start_line, comment.line || thread.line),
            body: comment.body
          })
        }
      }
    } else {
      for (const comment of this.#input.reviewComments) {
        add({
          at: comment.created_at || comment.updated_at,
          kind: "review comment",
          ref: comment.id,
          actor: comment.user?.login,
          state: comment.in_reply_to_id ? "reply" : "comment",
          location: location(comment.path, comment.start_line || comment.startLine, comment.line),
          body: comment.body
        })
      }
    }

    const reviewsWithInlineComments = new Set(
      this.#input.reviewComments
        .map(comment => comment.pull_request_review_id)
        .filter((reviewId): reviewId is number => typeof reviewId === "number")
    )
    for (const review of this.#input.reviews) {
      // GitHub creates a COMMENTED review shell for inline comments and replies; the thread events already carry more detail.
      const hasInlineComments = typeof review.id === "number" && reviewsWithInlineComments.has(review.id)
      const body = hasInlineComments ? "" : String(review.body || "").trim()
      if (!body && review.state?.toUpperCase() === "COMMENTED") {
        continue
      }
      add({
        at: review.submitted_at || review.submittedAt || "",
        kind: "review",
        ref: review.id,
        actor: review.user?.login,
        state: review.state,
        body
      })
    }

    entries.sort((left, right) => left.at.localeCompare(right.at))
    const visible = entries.slice(-HISTORY_ENTRY_LIMIT)
    return {
      olderEntriesOmitted: entries.length - visible.length,
      entries: visible.map(entry => `${entry.at || "unknown-time"} | ${entry.text}`)
    }
  }

  /** Finds direct requests that still require a top-level answer or thread reply. */
  #actionItems(): ReviewActionItem[] {
    const items: ReviewActionItem[] = []
    const trigger = this.#input.trigger
    const botLogin = this.#input.request.botLogin

    if (trigger.comment) {
      items.push({
        id: `issue-comment:${trigger.comment.id}`,
        kind: "trigger_request",
        actor: trigger.comment.author,
        body: ReviewEvidence.#compact(trigger.comment.body, ACTION_TEXT_LIMIT),
        commentId: trigger.comment.id
      })
    }

    const latestBotActivity = this.#latestBotActivity()
    for (const comment of this.#input.issueComments) {
      const createdAt = comment.created_at || comment.updated_at || null
      if (
        comment.id === trigger.comment?.id ||
        comment.user?.login === botLogin ||
        !this.#mentionsReviewer(comment.body) ||
        (latestBotActivity !== null && createdAt && Date.parse(createdAt) <= latestBotActivity)
      ) {
        continue
      }
      items.push({
        id: `issue-comment:${comment.id}`,
        kind: "mentioned",
        actor: comment.user?.login || null,
        body: ReviewEvidence.#compact(comment.body, ACTION_TEXT_LIMIT),
        commentId: comment.id,
        createdAt
      })
    }

    if (this.#input.reviewThreadsAvailable) {
      // GraphQL thread grouping and resolution state are authoritative when available.
      for (const thread of this.#input.reviewThreads) {
        if (
          thread.is_resolved ||
          thread.top_level_author !== botLogin ||
          thread.latest_author === botLogin ||
          !thread.top_level_comment_id
        ) {
          continue
        }
        const latest = thread.comments[thread.comments.length - 1]
        items.push({
          id: `review-thread:${thread.id}`,
          kind: "reply_requested",
          actor: thread.latest_author,
          body: ReviewEvidence.#compact(latest?.body, ACTION_TEXT_LIMIT),
          replyToCommentId: thread.top_level_comment_id,
          latestReplyId: thread.latest_comment_id,
          reviewThreadId: thread.id,
          path: thread.path,
          line: thread.line
        })
      }
      return items
    }

    // REST comments lack resolution state, but their parent ids still recover
    // direct human replies when GraphQL review threads are unavailable.
    const commentsByParent = new Map<number, ReviewComment[]>()
    for (const comment of this.#input.reviewComments) {
      const parent = comment.in_reply_to_id || comment.id
      commentsByParent.set(parent, [...(commentsByParent.get(parent) || []), comment])
    }
    for (const [parent, comments] of commentsByParent) {
      const topLevel = comments.find(comment => comment.id === parent)
      if (topLevel?.user?.login !== botLogin) {
        continue
      }
      const latest = comments.toSorted(
        (left, right) => Date.parse(left.created_at || "1970-01-01") - Date.parse(right.created_at || "1970-01-01")
      )[comments.length - 1]
      if (latest?.user?.login && latest.user.login !== botLogin) {
        items.push({
          id: `review-comment:${parent}`,
          kind: "reply_requested",
          actor: latest.user.login,
          body: ReviewEvidence.#compact(latest.body, ACTION_TEXT_LIMIT),
          replyToCommentId: parent,
          latestReplyId: latest.id
        })
      }
    }
    return items
  }

  #mentionsReviewer(body: unknown): boolean {
    const text = String(body || "").toLowerCase()
    const bot = this.#input.request.botLogin.toLowerCase()
    return text.includes(REVIEW_COMMAND) || text.includes(`@${bot}`)
  }

  #latestBotActivity(): number | null {
    const timestamps: number[] = []
    for (const comment of this.#input.issueComments) {
      if (comment.user?.login === this.#input.request.botLogin) {
        timestamps.push(Date.parse(comment.created_at || comment.updated_at || ""))
      }
    }
    for (const review of this.#input.reviews) {
      if (review.user?.login === this.#input.request.botLogin) {
        timestamps.push(Date.parse(review.submitted_at || review.submittedAt || ""))
      }
    }
    const valid = timestamps.filter(Number.isFinite)
    return valid.length > 0 ? Math.max(...valid) : null
  }

  /** Collects human handles once so synthesis can address the right participant. */
  #participants(actionItems: ReviewActionItem[]): string[] {
    const people = new Map<string, string>()
    this.#addParticipant(people, this.#input.trigger.actor)
    this.#addParticipant(people, this.#input.trigger.comment?.author)
    this.#addParticipant(people, this.#input.pullRequest.author?.login || this.#input.pullRequest.user?.login)
    for (const commit of this.#input.commits) {
      this.#addParticipant(people, commit.author?.login, commit.commit?.author?.name)
      this.#addParticipant(people, commit.committer?.login, commit.commit?.committer?.name)
    }
    for (const comment of this.#input.issueComments) {
      this.#addParticipant(people, comment.user?.login)
    }
    for (const review of this.#input.reviews) {
      this.#addParticipant(people, review.user?.login)
    }
    for (const thread of this.#input.reviewThreads) {
      for (const comment of thread.comments) {
        this.#addParticipant(people, comment.user.login)
      }
    }
    for (const item of actionItems) {
      this.#addParticipant(people, item.actor)
    }
    return [...people.values()]
  }

  /** Prefers a participant's human-readable name without ever retaining bots. */
  #addParticipant(people: Map<string, string>, login?: string | null, name?: string | null): void {
    if (!login) {
      return
    }
    const normalized = login.toLowerCase()
    const bot = this.#input.request.botLogin.toLowerCase()
    if (normalized === bot || normalized === bot.replace(/\[bot\]$/u, "") || /\[bot\]$/u.test(normalized)) {
      return
    }

    const named = name && name.toLowerCase() !== normalized
    const label = named ? `${name} (@${login})` : `@${login}`
    const existing = people.get(normalized)
    if (!existing || (named && !existing.includes("("))) {
      people.set(normalized, label)
    }
  }
}
