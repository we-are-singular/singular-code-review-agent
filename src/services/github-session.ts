import type {
  GitHubClient,
  IssueComment,
  PullRequestReview,
  Reaction,
  ReviewComment,
  ReviewThreadsResult
} from "./github-client.js"
import { ReviewEvidence } from "./review-evidence.js"
import { ReviewDiff } from "../lib/review-diff.js"
import type { ReviewRequest, ReviewSnapshot } from "../types/review.js"

const TRIGGER_TEXT_LIMIT = 1_600

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

  /** Reads active or explicitly referenced pull-request metadata once. */
  getPullRequest(prNumber = this.#request.prNumber, repository = this.#request.repository) {
    return this.#once(`pull-request:${repository}#${prNumber}`, () => this.#github.getPullRequest(prNumber, repository))
  }

  /** Filters and parses active or referenced PR diffs before sharing them. */
  getPullRequestDiff(prNumber = this.#request.prNumber, repository = this.#request.repository) {
    return this.#once(`pull-request-diff:${repository}#${prNumber}`, async () =>
      ReviewDiff.from(await this.#github.getPullRequestDiff(prNumber, repository))
    )
  }

  /** Resolves an issue explicitly referenced by review evidence. */
  getIssue(issueNumber: number, repository = this.#request.repository) {
    return this.#once(`issue:${repository}#${issueNumber}`, () => this.#github.getIssue(issueNumber, repository))
  }

  /** Resolves a commit explicitly referenced by review evidence. */
  getCommit(ref: string, repository = this.#request.repository) {
    return this.#once(`commit:${repository}@${ref}`, () => this.#github.getCommit(ref, repository))
  }

  /** Reads the trusted trigger comment by its repository-wide database id. */
  getIssueComment(commentId: number) {
    return this.#once(`issue-comment:${commentId}`, () => this.#github.getIssueComment(commentId))
  }

  /** Applies ignoreHistory only to the active PR, never to a linked issue. */
  listIssueComments(
    issueNumber = this.#request.prNumber,
    repository = this.#request.repository
  ): Promise<IssueComment[]> {
    const activePullRequest = issueNumber === this.#request.prNumber && repository === this.#request.repository
    return activePullRequest && this.#request.ignoreHistory
      ? Promise.resolve([])
      : this.#once(`issue-comments:${repository}#${issueNumber}`, () =>
          this.#github.listIssueComments(issueNumber, repository)
        )
  }

  /** Loads flat review comments for replies and REST thread fallback. */
  listReviewComments(): Promise<ReviewComment[]> {
    return this.#request.ignoreHistory
      ? Promise.resolve([])
      : this.#once("review-comments", () => this.#github.listReviewComments(this.#request.prNumber))
  }

  /** Loads completed reviews used to anchor follow-up deltas. */
  listReviews(): Promise<PullRequestReview[]> {
    return this.#request.ignoreHistory
      ? Promise.resolve([])
      : this.#once("reviews", () => this.#github.listReviews(this.#request.prNumber))
  }

  /** Loads commit messages and authors for the durable PR evidence file. */
  listPullRequestCommits() {
    return this.#once("commits", () => this.#github.listPullRequestCommits(this.#request.prNumber))
  }

  /** Loads GraphQL thread resolution state when the token permits it. */
  listReviewThreads(): Promise<ReviewThreadsResult> {
    return this.#request.ignoreHistory
      ? Promise.resolve({ available: true, threads: [] })
      : this.#once("review-threads", () => this.#github.listReviewThreads(this.#request.prNumber))
  }

  /** Reads acknowledgement state so repeated runs do not duplicate reactions. */
  listIssueCommentReactions(commentId: number): Promise<Reaction[]> {
    return this.#once(`issue-comment-reactions:${commentId}`, () => this.#github.listIssueCommentReactions(commentId))
  }

  /** Refuses to publish evidence collected for a head GitHub has since replaced. */
  async assertHeadUnchanged(): Promise<void> {
    const reviewed = (await this.snapshot()).pullRequest
    const current = await this.#github.getPullRequest(this.#request.prNumber)
    const reviewedHead = reviewed.headRefOid || reviewed.head?.sha || null
    const currentHead = current.headRefOid || current.head?.sha || null

    if (!reviewedHead || !currentHead) {
      throw new Error("cannot verify the pull request head before publication")
    }
    if (currentHead !== reviewedHead) {
      throw new Error(`pull request head changed during review: reviewed ${reviewedHead}, current ${currentHead}`)
    }
  }

  /** Builds the one evidence snapshot consumed by every deterministic and AML phase. */
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
      let trigger = ReviewEvidence.trigger(this.#request)
      if (!trigger.comment && this.#request.triggerCommentId) {
        const comment =
          issueComments.find(candidate => candidate.id === this.#request.triggerCommentId) ||
          (await this.getIssueComment(this.#request.triggerCommentId))
        trigger = {
          ...trigger,
          reason: "mention",
          actor: trigger.actor || comment.user?.login || null,
          comment: {
            id: comment.id,
            author: comment.user?.login || null,
            body: String(comment.body || "").slice(0, TRIGGER_TEXT_LIMIT)
          }
        }
      }

      return new ReviewEvidence({
        request: this.#request,
        trigger,
        pullRequest,
        diff: {
          text: filteredDiff.text,
          files: filteredDiff.files.map(file => file.path),
          ignoredFiles: filteredDiff.ignoredFiles,
          commentRanges: filteredDiff.commentRanges
        },
        issueComments,
        reviewComments,
        reviews,
        commits,
        reviewThreadsAvailable: threadsResult.available,
        reviewThreads: threadsResult.threads
      }).snapshot()
    })
  }
}
