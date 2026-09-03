import type {
  GitHubClient,
  IssueComment,
  PullRequestReview,
  PullRequestTimelineEvent,
  IssueTimelineEvent,
  Reaction,
  ReviewComment,
  ReviewThreadsResult
} from "./client.js"
import { NotAnIssueError } from "./client.js"
import { GitHubContextService } from "./context.js"
import { parseRelatedIssueReferences } from "./context-model.js"
import { ReviewEvidence } from "../review-evidence.js"
import { ReviewDiff } from "../../lib/review-diff.js"
import type { ReviewRequest, ReviewSnapshot } from "../../types/review.js"

const TRIGGER_TEXT_LIMIT = 1_600

/**
 * One request-scoped GitHub boundary. Every Tool and deterministic phase sees
 * the same cached reads, while narrow deterministic mutations remain disabled
 * unless the caller explicitly enables publication.
 */
export class GitHubReviewSession {
  readonly #github: GitHubClient
  readonly #request: ReviewRequest
  readonly #allowMutations: boolean
  readonly #cache = new Map<string, Promise<unknown>>()
  readonly context: GitHubContextService

  constructor(github: GitHubClient, request: ReviewRequest, allowMutations = false) {
    this.#github = github
    this.#request = request
    this.#allowMutations = allowMutations
    this.context = new GitHubContextService(this, request.repository)
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

  /** Parses a fresh projection from the cached raw diff response. */
  async getPullRequestDiff(prNumber = this.#request.prNumber, repository = this.#request.repository) {
    // Cache only the endpoint response. Filtering and comment-range derivation
    // are deterministic, cheap consumer work and do not belong in session state.
    const raw = await this.#once(`pull-request-diff:${repository}#${prNumber}`, () =>
      this.#github.getPullRequestDiff(prNumber, repository)
    )
    return ReviewDiff.from(raw)
  }

  /** Resolves an issue explicitly referenced by review evidence. */
  getIssue(issueNumber: number, repository = this.#request.repository) {
    return this.#once(`issue:${repository}#${issueNumber}`, () => this.#github.getIssue(issueNumber, repository))
  }

  /** Discovers issues GitHub will close when the active pull request merges. */
  listPullRequestClosingIssues(prNumber = this.#request.prNumber, repository = this.#request.repository) {
    return this.#once(`pull-request-closing-issues:${repository}#${prNumber}`, () =>
      this.#github.listPullRequestClosingIssues(prNumber, repository)
    )
  }

  /** Resolves a commit explicitly referenced by review evidence. */
  getCommit(ref: string, repository = this.#request.repository) {
    return this.#once(`commit:${repository}@${ref}`, () => this.#github.getCommit(ref, repository))
  }

  /** Reads the trusted trigger comment by its repository-wide database id. */
  getIssueComment(commentId: number, repository = this.#request.repository) {
    return this.#once(`issue-comment:${repository}:${commentId}`, () =>
      this.#github.getIssueComment(commentId, repository)
    )
  }

  /** Reads one top-level issue or pull-request conversation comment by database id. */
  getComment(commentId: number, repository = this.#request.repository) {
    return this.getIssueComment(commentId, repository)
  }

  /** Reads top-level conversation comments for a pull request. */
  listPullRequestComments(
    prNumber = this.#request.prNumber,
    repository = this.#request.repository
  ): Promise<IssueComment[]> {
    const activePullRequest = prNumber === this.#request.prNumber && repository === this.#request.repository
    return activePullRequest && this.#request.ignoreHistory
      ? Promise.resolve([])
      : this.#once(`pull-request-comments:${repository}#${prNumber}`, () =>
          this.#github.listPullRequestComments(prNumber, repository)
        )
  }

  /** Reads complete chronological comments for a real issue. */
  listIssueComments(issueNumber: number, repository = this.#request.repository): Promise<IssueComment[]> {
    return this.#once(`issue-comments:${repository}#${issueNumber}`, () =>
      this.#github.listIssueComments(issueNumber, repository)
    )
  }

  /** Reads issue lifecycle events and cross-references separately from comments. */
  listIssueTimeline(issueNumber: number, repository = this.#request.repository): Promise<IssueTimelineEvent[]> {
    return this.#once(`issue-timeline:${repository}#${issueNumber}`, () =>
      this.#github.listIssueTimeline(issueNumber, repository)
    )
  }

  /** Loads flat review comments for replies and REST thread fallback. */
  listReviewComments(
    prNumber = this.#request.prNumber,
    repository = this.#request.repository
  ): Promise<ReviewComment[]> {
    const activePullRequest = prNumber === this.#request.prNumber && repository === this.#request.repository
    return activePullRequest && this.#request.ignoreHistory
      ? Promise.resolve([])
      : this.#once(`review-comments:${repository}#${prNumber}`, () =>
          this.#github.listReviewComments(prNumber, repository)
        )
  }

  /** Loads completed reviews used to anchor follow-up deltas. */
  listReviews(prNumber = this.#request.prNumber, repository = this.#request.repository): Promise<PullRequestReview[]> {
    const activePullRequest = prNumber === this.#request.prNumber && repository === this.#request.repository
    return activePullRequest && this.#request.ignoreHistory
      ? Promise.resolve([])
      : this.#once(`reviews:${repository}#${prNumber}`, () => this.#github.listReviews(prNumber, repository))
  }

  /** Loads non-comment pull-request lifecycle and scope changes. */
  listPullRequestTimeline(
    prNumber = this.#request.prNumber,
    repository = this.#request.repository
  ): Promise<PullRequestTimelineEvent[]> {
    const activePullRequest = prNumber === this.#request.prNumber && repository === this.#request.repository
    return activePullRequest && this.#request.ignoreHistory
      ? Promise.resolve([])
      : this.#once(`pull-request-timeline:${repository}#${prNumber}`, () =>
          this.#github.listPullRequestTimeline(prNumber, repository)
        )
  }

  /** Loads commit messages and authors for the durable PR evidence file. */
  listPullRequestCommits(prNumber = this.#request.prNumber, repository = this.#request.repository) {
    return this.#once(`commits:${repository}#${prNumber}`, () =>
      this.#github.listPullRequestCommits(prNumber, repository)
    )
  }

  /** Loads GraphQL thread resolution state when the token permits it. */
  listReviewThreads(
    prNumber = this.#request.prNumber,
    repository = this.#request.repository
  ): Promise<ReviewThreadsResult> {
    const activePullRequest = prNumber === this.#request.prNumber && repository === this.#request.repository
    return activePullRequest && this.#request.ignoreHistory
      ? Promise.resolve({ available: true, threads: [] })
      : this.#once(`review-threads:${repository}#${prNumber}`, () =>
          this.#github.listReviewThreads(prNumber, repository)
        )
  }

  /** Reads acknowledgement state so repeated runs do not duplicate reactions. */
  listIssueCommentReactions(commentId: number): Promise<Reaction[]> {
    return this.#once(`issue-comment-reactions:${commentId}`, () => this.#github.listIssueCommentReactions(commentId))
  }

  /** Adds the deterministic acknowledgement only when live mutations are enabled. */
  async reactToIssueComment(commentId: number): Promise<void> {
    if (this.#allowMutations) {
      await this.#github.createIssueCommentReaction(commentId, "eyes")
    }
  }

  /** Refuses to publish evidence collected for a head GitHub has since replaced. */
  async assertReviewContextUnchanged(): Promise<void> {
    const snapshot = await this.snapshot()
    const reviewed = snapshot.pullRequest

    // Bypass the request cache for every freshness read. Cached evidence proves
    // what was reviewed; these direct client reads prove what GitHub has now.
    const current = await this.#github.getPullRequest(this.#request.prNumber, this.#request.repository)
    const reviewedHead = reviewed.headRefOid || reviewed.head?.sha || null
    const currentHead = current.headRefOid || current.head?.sha || null

    if (!reviewedHead || !currentHead) {
      throw new Error("cannot verify the pull request head before publication")
    }
    if (currentHead !== reviewedHead) {
      throw new Error(`pull request head changed during review: reviewed ${reviewedHead}, current ${currentHead}`)
    }

    // The description owns explicit `related to` references, so a body change
    // can change both stated intent and the issue set without changing the head.
    if (String(current.body || "") !== snapshot.context.description) {
      throw new Error("pull request description or referenced issue set changed during review; run the review again")
    }

    // Re-resolve GitHub-native closing references and explicit related clauses.
    // Relationship type is part of the signature because `closes` is a claimed
    // contract while `related` is enrichment only.
    const closingIssues = await this.#github.listPullRequestClosingIssues(
      this.#request.prNumber,
      this.#request.repository
    )
    const closingKeys = new Set(
      closingIssues.map(issue => `${issue.repository || this.#request.repository}#${issue.number}`)
    )
    const related = parseRelatedIssueReferences(current.body || "", this.#request.repository).filter(
      reference => !closingKeys.has(`${reference.repository}#${reference.number}`)
    )
    // A `related to` clause naming a pull request resolves the same way during
    // the initial snapshot, so the freshness signature skips it identically.
    const latestRelated = (
      await Promise.all(
        related.map(async reference => {
          try {
            return {
              relation: "related" as const,
              issue: await this.#github.getIssue(reference.number, reference.repository),
              repository: reference.repository
            }
          } catch (error) {
            if (error instanceof NotAnIssueError) return null
            throw error
          }
        })
      )
    ).flatMap(entry => (entry ? [entry] : []))
    const latestIssues = (
      await Promise.all([
        ...closingIssues.map(async issue => ({
          relation: "closes" as const,
          issue,
          repository: issue.repository || this.#request.repository
        })),
        ...latestRelated
      ])
    )
      .map(
        context =>
          `${context.relation}:${context.repository}#${context.issue.number}@${context.issue.updated_at || "unknown"}`
      )
      .toSorted()
    const reviewedIssues = snapshot.context.issues
      .map(issue => `${issue.relation}:${issue.repository}#${issue.number}@${issue.updatedAt || "unknown"}`)
      .toSorted()

    // Issue `updatedAt` covers body, comment, and lifecycle changes without
    // replaying every compact history event solely for a freshness comparison.
    if (JSON.stringify(latestIssues) !== JSON.stringify(reviewedIssues)) {
      throw new Error("referenced issue requirements changed during review; run the review again")
    }
  }

  /** Builds the one evidence snapshot consumed by every deterministic and AML phase. */
  snapshot(): Promise<ReviewSnapshot> {
    return this.#once("snapshot", async () => {
      // The context service is the single gathering path for both the compact
      // model DTO and the rich evidence needed by deterministic review logic.
      const evidence = await this.context.pullRequest(this.#request.prNumber, this.#request.repository)
      const { pullRequest, diff: filteredDiff, issueComments } = evidence
      let trigger = ReviewEvidence.trigger(this.#request)

      // Mention runs need the exact trusted trigger comment. Reuse the gathered
      // PR conversation first, then fall back to the repository-wide comment id.
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
          files: filteredDiff.files,
          ignoredFiles: filteredDiff.ignoredFiles,
          commentRanges: filteredDiff.commentRanges
        },
        issueComments,
        referencedIssues: evidence.referencedIssues,
        reviewComments: evidence.reviewComments,
        reviews: evidence.reviews,
        commits: evidence.commits,
        context: evidence.context,
        reviewThreadsAvailable: evidence.threadsResult.available,
        reviewThreads: evidence.threadsResult.threads
      }).snapshot()
    })
  }
}
