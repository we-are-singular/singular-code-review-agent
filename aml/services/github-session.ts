import type { GitHubClient, Reaction, ReviewThreadsResult } from "../../src/clients/github.js"
import {
  buildActionItems,
  buildReviewerContext,
  buildValidationContext,
  readEventContext
} from "../../src/review/context.js"
import { filterReviewDiff, parseUnifiedDiff, validCommentRangesFromDiff } from "../../src/review/diff.js"
import {
  REVIEW_COMMAND,
  type IssueComment,
  type PullRequestCommit,
  type PullRequestReview,
  type ReviewComment,
  type ReviewContext
} from "../../src/review/types.js"
import type { ReviewRequest, ReviewSnapshot } from "../review-result.js"

type TimelineItem = {
  at: string
  text: string
}

function compact(value: unknown, limit = 240): string {
  const text = String(value || "")
    .replace(/\s+/gu, " ")
    .trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`
}

/** Keeps enough chronological context for follow-up reviews without raw API noise. */
function timeline(options: {
  commits: PullRequestCommit[]
  issueComments: IssueComment[]
  reviewComments: ReviewComment[]
  reviews: PullRequestReview[]
}): ReviewContext["pr_timeline"] {
  const items: TimelineItem[] = []

  for (const commit of options.commits) {
    items.push({
      at: commit.commit?.committer?.date || commit.commit?.author?.date || "",
      text: ["commit", commit.sha?.slice(0, 7), commit.author?.login, compact(commit.commit?.message)]
        .filter(Boolean)
        .join(" | ")
    })
  }
  for (const comment of options.issueComments) {
    items.push({
      at: comment.created_at || comment.updated_at || "",
      text: ["issue comment", `#${comment.id}`, comment.user?.login, compact(comment.body)].filter(Boolean).join(" | ")
    })
  }
  for (const comment of options.reviewComments) {
    items.push({
      at: comment.created_at || comment.updated_at || "",
      text: ["review comment", `#${comment.id}`, comment.user?.login, comment.path, comment.line, compact(comment.body)]
        .filter(Boolean)
        .join(" | ")
    })
  }
  for (const review of options.reviews) {
    items.push({
      at: review.submitted_at || review.submittedAt || "",
      text: ["review", review.user?.login, review.state, review.commit_id?.slice(0, 7), compact(review.body)]
        .filter(Boolean)
        .join(" | ")
    })
  }

  items.sort((left, right) => left.at.localeCompare(right.at))
  const visible = items.slice(-60)
  return {
    full_event_file: "",
    older_entries_omitted_due_to_long_history: Math.max(0, items.length - visible.length),
    chronological_entries: visible.map(item => `${item.at || "unknown-time"} | ${item.text}`)
  }
}

/**
 * One request-scoped GitHub read model. Every Tool and deterministic phase sees
 * the same cached values, so parallel lanes never repeat API pagination.
 */
export class GitHubReviewSession {
  readonly #github: GitHubClient
  readonly #request: ReviewRequest
  readonly #cache = new Map<string, Promise<unknown>>()

  constructor(github: GitHubClient, request: ReviewRequest) {
    this.#github = github
    this.#request = request
  }

  get request(): ReviewRequest {
    return this.#request
  }

  /** Coalesces concurrent reads as promises rather than caching only resolved data. */
  #once<Value>(key: string, load: () => Promise<Value>): Promise<Value> {
    const existing = this.#cache.get(key)
    if (existing) {
      return existing as Promise<Value>
    }
    const pending = load()
    this.#cache.set(key, pending)
    return pending
  }

  getPullRequest() {
    return this.#once("pull-request", () => this.#github.getPullRequest(this.#request.prNumber))
  }

  getPullRequestDiff() {
    return this.#once("pull-request-diff", async () =>
      filterReviewDiff(await this.#github.getPullRequestDiff(this.#request.prNumber))
    )
  }

  getIssueComment(commentId: number) {
    return this.#once(`issue-comment:${commentId}`, () => this.#github.getIssueComment(commentId))
  }

  listIssueComments(): Promise<IssueComment[]> {
    return this.#request.ignoreHistory
      ? Promise.resolve([])
      : this.#once("issue-comments", () => this.#github.listIssueComments(this.#request.prNumber))
  }

  listReviewComments(): Promise<ReviewComment[]> {
    return this.#request.ignoreHistory
      ? Promise.resolve([])
      : this.#once("review-comments", () => this.#github.listReviewComments(this.#request.prNumber))
  }

  listReviews(): Promise<PullRequestReview[]> {
    return this.#request.ignoreHistory
      ? Promise.resolve([])
      : this.#once("reviews", () => this.#github.listReviews(this.#request.prNumber))
  }

  listPullRequestCommits() {
    return this.#once("commits", () => this.#github.listPullRequestCommits(this.#request.prNumber))
  }

  listReviewThreads(): Promise<ReviewThreadsResult> {
    return this.#request.ignoreHistory
      ? Promise.resolve({ available: true, threads: [] })
      : this.#once("review-threads", () => this.#github.listReviewThreads(this.#request.prNumber))
  }

  listIssueCommentReactions(commentId: number): Promise<Reaction[]> {
    return this.#once(`issue-comment-reactions:${commentId}`, () => this.#github.listIssueCommentReactions(commentId))
  }

  /** Refuses to publish evidence collected for a head GitHub has since replaced. */
  async assertHeadUnchanged(): Promise<void> {
    const reviewed = (await this.snapshot()).pullRequest
    const current = await this.#github.getPullRequest(this.#request.prNumber)
    const reviewedHead = reviewed.headRefOid || (reviewed.head as { sha?: string | null } | undefined)?.sha || null
    const currentHead = current.headRefOid || (current.head as { sha?: string | null } | undefined)?.sha || null

    if (!reviewedHead || !currentHead) {
      throw new Error("cannot verify the pull request head before publication")
    }
    if (currentHead !== reviewedHead) {
      throw new Error(`pull request head changed during review: reviewed ${reviewedHead}, current ${currentHead}`)
    }
  }

  /** Builds the complete in-memory review context from the cached GitHub reads. */
  snapshot(): Promise<ReviewSnapshot> {
    return this.#once("snapshot", async () => {
      const [pullRequest, filteredDiff, commits, issueComments, reviewComments, reviews, threadsResult] =
        await Promise.all([
          this.getPullRequest(),
          this.getPullRequestDiff(),
          this.listPullRequestCommits(),
          this.listIssueComments(),
          this.listReviewComments(),
          this.listReviews(),
          this.listReviewThreads()
        ])
      const trigger = readEventContext({
        eventName: this.#request.eventName,
        eventPath: this.#request.eventPath,
        actor: this.#request.actor
      })
      const unresolvedThreads = threadsResult.threads.filter(thread => !thread.is_resolved)
      const unresolvedBotThreads = unresolvedThreads.filter(
        thread => thread.top_level_author === this.#request.botLogin
      )
      const generatedAt = new Date().toISOString()
      const context: ReviewContext = {
        generated_at: generatedAt,
        run: {
          ...trigger,
          command: REVIEW_COMMAND,
          bot_login: this.#request.botLogin
        },
        pr: pullRequest,
        diff: {
          file: "",
          files: parseUnifiedDiff(filteredDiff.text).files.map(file => file.path),
          ignored_files: filteredDiff.ignoredFiles
        },
        valid_comment_ranges: validCommentRangesFromDiff(filteredDiff.text),
        issue_comments: issueComments,
        review_comments: reviewComments,
        review_threads_available: threadsResult.available,
        review_threads: threadsResult.threads,
        unresolved_review_threads: unresolvedThreads,
        unresolved_bot_threads: unresolvedBotThreads,
        reviews,
        pr_commits: commits,
        pr_timeline: timeline({ commits, issueComments, reviewComments, reviews }),
        previous_bot_findings: reviewComments.filter(
          comment => comment.user?.login === this.#request.botLogin && !comment.in_reply_to_id
        ),
        action_items: buildActionItems({
          trigger,
          issueComments,
          reviewComments,
          reviewThreads: threadsResult.threads,
          reviewThreadsAvailable: threadsResult.available,
          reviews,
          botLogin: this.#request.botLogin,
          command: REVIEW_COMMAND
        })
      }

      return Object.freeze({
        pullRequest,
        context,
        reviewerContext: buildReviewerContext(context),
        validationContext: buildValidationContext(context),
        diff: filteredDiff.text
      })
    })
  }
}
