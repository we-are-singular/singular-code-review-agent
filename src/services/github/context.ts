import type { ReviewDiff } from "../../lib/review-diff.js"
import { NotAnIssueError } from "./client.js"
import {
  CONTEXT_HISTORY_ENTRY_LIMIT,
  compactContextText,
  compactHistory,
  parseRelatedIssueReferences,
  type CompactHistoryEntry,
  type CompactIssueContext,
  type CompactPullRequestContext
} from "./context-model.js"
import type {
  IssueComment,
  IssueSummary,
  IssueTimelineEvent,
  PullRequestCommit,
  PullRequestReview,
  PullRequestSummary,
  PullRequestTimelineEvent,
  ReferencedIssueContext,
  ReviewComment,
  ReviewThreadsResult
} from "./client.js"

// Comments, reviews, and commits have richer dedicated reads. Keep this list to
// lifecycle and scope events so the compact history does not repeat evidence.
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

/** Cached read port required to assemble rich PR and issue evidence. */
export type GitHubContextSource = {
  getPullRequest(prNumber?: number, repository?: string): Promise<PullRequestSummary>
  getPullRequestDiff(prNumber?: number, repository?: string): Promise<ReviewDiff>
  getIssue(issueNumber: number, repository?: string): Promise<IssueSummary>
  listPullRequestClosingIssues(prNumber?: number, repository?: string): Promise<IssueSummary[]>
  listPullRequestComments(prNumber?: number, repository?: string): Promise<IssueComment[]>
  listIssueComments(issueNumber: number, repository?: string): Promise<IssueComment[]>
  listIssueTimeline(issueNumber: number, repository?: string): Promise<IssueTimelineEvent[]>
  listReviewComments(prNumber?: number, repository?: string): Promise<ReviewComment[]>
  listReviews(prNumber?: number, repository?: string): Promise<PullRequestReview[]>
  listPullRequestTimeline(prNumber?: number, repository?: string): Promise<PullRequestTimelineEvent[]>
  listPullRequestCommits(prNumber?: number, repository?: string): Promise<PullRequestCommit[]>
  listReviewThreads(prNumber?: number, repository?: string): Promise<ReviewThreadsResult>
}

/** Rich application-owned evidence plus its compact model-facing projection. */
export type PullRequestEvidence = {
  repository: string
  pullRequest: PullRequestSummary
  diff: ReviewDiff
  issueComments: IssueComment[]
  referencedIssues: ReferencedIssueContext[]
  reviewComments: ReviewComment[]
  reviews: PullRequestReview[]
  timelineEvents: PullRequestTimelineEvent[]
  commits: PullRequestCommit[]
  threadsResult: ReviewThreadsResult
  context: CompactPullRequestContext
}

function location(path?: string | null, start?: number | null, end?: number | null): string | null {
  if (!path) return null
  if (start && end && start !== end) return `${path}:${start}-${end}`
  return end || start ? `${path}:${end || start}` : path
}

/** Normalizes every GitHub event source into the one compact history shape. */
function historyEntry(input: {
  at?: string | null
  kind: string
  reference?: string | number | null
  actor?: string | null
  state?: string | null
  location?: string | null
  body?: unknown
  url?: string | null
}): CompactHistoryEntry {
  return {
    at: input.at || null,
    kind: input.kind,
    reference: input.reference === undefined || input.reference === null ? null : String(input.reference),
    actor: input.actor || null,
    state: input.state || null,
    location: input.location || null,
    body: input.body === undefined || input.body === null ? null : compactContextText(input.body) || null,
    url: input.url || null
  }
}

/** Combines issue edits, discussion, and lifecycle events without raw payloads. */
function issueHistory(issue: IssueSummary, comments: IssueComment[], timeline: IssueTimelineEvent[]) {
  const entries: CompactHistoryEntry[] = []
  // Description edits explain pivots that the current issue body alone hides.
  for (const edit of issue.edits || []) {
    entries.push(
      historyEntry({
        at: edit.editedAt,
        kind: "description edited",
        actor: edit.editor?.login,
        body: edit.diff
      })
    )
  }
  // Keep decision prose, but compact it before it crosses the Tool boundary.
  for (const comment of comments) {
    entries.push(
      historyEntry({
        at: comment.created_at || comment.updated_at,
        kind: "comment",
        reference: comment.id,
        actor: comment.user?.login,
        state: comment.author_association,
        body: comment.body,
        url: comment.html_url
      })
    )
  }
  // Comment events duplicate the dedicated comment read; lifecycle events do not.
  for (const event of timeline) {
    if (!event.event || event.event === "commented") continue
    const detail = event.rename
      ? `${event.rename.from || "unknown"} → ${event.rename.to || "unknown"}`
      : event.label?.name ||
        event.assignee?.login ||
        event.requested_reviewer?.login ||
        event.commit_id?.slice(0, 12) ||
        event.source?.issue?.html_url ||
        null
    entries.push(
      historyEntry({
        at: event.created_at,
        kind: event.event.replaceAll("_", " "),
        actor: event.actor?.login,
        state: detail
      })
    )
  }
  // Issue discussions can outlive the PR by years. Apply the same bounded
  // tail used for PR history so one reference cannot crowd out current context.
  return compactHistory(entries, CONTEXT_HISTORY_ENTRY_LIMIT)
}

/** Projects rich issue evidence while preserving the complete current contract. */
function compactIssue(context: ReferencedIssueContext): CompactIssueContext {
  const { issue, relation, repository } = context
  return {
    kind: "issue",
    relation,
    repository,
    number: issue.number,
    url: issue.html_url || null,
    title: issue.title || "",
    description: issue.body || "",
    state: issue.state || null,
    author: issue.user?.login || null,
    labels: (issue.labels || []).flatMap(label => (label.name ? [label.name] : [])),
    createdAt: issue.created_at || null,
    updatedAt: issue.updated_at || null,
    history: issueHistory(issue, context.comments, context.timeline)
  }
}

/**
 * Builds one chronological, bounded PR history from all GitHub discussion sources.
 *
 * Bodies are compacted here rather than in Markdown rendering so `get_pr`,
 * `history.md`, audit, and synthesis all consume the same validated evidence.
 */
export function buildPullRequestHistory(input: {
  pullRequest: PullRequestSummary
  commits: PullRequestCommit[]
  issueComments: IssueComment[]
  reviewComments: ReviewComment[]
  reviews: PullRequestReview[]
  timelineEvents: PullRequestTimelineEvent[]
  threadsResult: ReviewThreadsResult
}) {
  const entries: CompactHistoryEntry[] = []
  // Commit subjects establish implementation phases without retaining bodies.
  for (const commit of input.commits) {
    entries.push(
      historyEntry({
        at: commit.commit?.committer?.date || commit.commit?.author?.date,
        kind: "commit",
        reference: commit.sha?.slice(0, 7),
        actor: commit.author?.login || commit.committer?.login,
        body: String(commit.commit?.message || "").split(/\r?\n/u)[0],
        url: commit.html_url
      })
    )
  }

  // GitHub does not expose the initial draft state in timeline events. Infer it
  // from the first transition, then record the opening event before later scope changes.
  const firstDraftTransition = input.timelineEvents
    .filter(event => event.event === "convert_to_draft" || event.event === "ready_for_review")
    .toSorted((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")))[0]
  const initiallyDraft = firstDraftTransition
    ? firstDraftTransition.event === "ready_for_review"
    : Boolean(input.pullRequest.isDraft ?? input.pullRequest.draft)
  const createdAt = input.pullRequest.createdAt || input.pullRequest.created_at
  if (createdAt) {
    entries.push(
      historyEntry({
        at: createdAt,
        kind: "pull request opened",
        actor: input.pullRequest.author?.login || input.pullRequest.user?.login,
        state: initiallyDraft ? "draft" : "ready"
      })
    )
  }

  // Retain only non-duplicative lifecycle and scope changes from the issue timeline.
  for (const event of input.timelineEvents) {
    if (!event.event || !INCLUDED_TIMELINE_EVENTS.has(event.event)) continue
    const subject =
      event.label?.name ||
      event.assignee?.login ||
      event.requested_reviewer?.login ||
      event.requested_team?.slug ||
      event.requested_team?.name ||
      event.commit_id?.slice(0, 7) ||
      (event.dismissed_review?.review_id ? `review #${event.dismissed_review.review_id}` : null)
    entries.push(
      historyEntry({
        at: event.created_at,
        kind: event.event.replaceAll("_", " "),
        actor: event.actor?.login,
        state: subject,
        body: event.rename
          ? `${event.rename.from || "unknown"} → ${event.rename.to || "unknown"}`
          : event.dismissed_review?.dismissal_message
      })
    )
  }
  // Top-level PR discussion carries pivots and direct author/reviewer decisions.
  for (const comment of input.issueComments) {
    entries.push(
      historyEntry({
        at: comment.created_at || comment.updated_at,
        kind: "issue comment",
        reference: comment.id,
        actor: comment.user?.login,
        state: comment.author_association,
        body: comment.body,
        url: comment.html_url
      })
    )
  }
  if (input.threadsResult.available) {
    // GraphQL owns resolved/outdated state, so prefer complete threads whenever available.
    for (const thread of input.threadsResult.threads) {
      const state = thread.is_resolved ? "resolved" : thread.is_outdated ? "outdated" : "unresolved"
      for (const comment of thread.comments) {
        entries.push(
          historyEntry({
            at: comment.created_at,
            kind: "review comment",
            reference: comment.id,
            actor: comment.user.login,
            state,
            location: location(
              comment.path || thread.path,
              comment.start_line || thread.start_line,
              comment.line || thread.line
            ),
            body: comment.body,
            url: comment.html_url
          })
        )
      }
    }
  } else {
    // REST comments are the explicit fallback when GraphQL thread access is unavailable.
    for (const comment of input.reviewComments) {
      entries.push(
        historyEntry({
          at: comment.created_at || comment.updated_at,
          kind: "review comment",
          reference: comment.id,
          actor: comment.user?.login,
          state: comment.in_reply_to_id ? "reply" : "comment",
          location: location(comment.path, comment.start_line || comment.startLine, comment.line),
          body: comment.body,
          url: comment.html_url || comment.url
        })
      )
    }
  }
  // Review shells carry decisions and substantive top-level bodies. Empty
  // COMMENTED shells merely group inline comments already captured above.
  for (const review of input.reviews) {
    const body = String(review.body || "").trim()
    if (!body && review.state?.toUpperCase() === "COMMENTED") continue
    entries.push(
      historyEntry({
        at: review.submitted_at || review.submittedAt,
        kind: "review",
        reference: review.id,
        actor: review.user?.login,
        state: review.state,
        body,
        url: review.html_url || review.url
      })
    )
  }
  return compactHistory(entries, CONTEXT_HISTORY_ENTRY_LIMIT)
}

/**
 * Owns GitHub entity gathering and application-facing context assembly.
 *
 * Rich DTOs stay available to deterministic application code for exact replies,
 * deduplication, and freshness checks. Serialization and rendering remain
 * downstream concerns so this service never caches presentation work.
 */
export class GitHubContextService {
  readonly #source: GitHubContextSource
  readonly #defaultRepository: string

  constructor(source: GitHubContextSource, defaultRepository: string) {
    this.#source = source
    this.#defaultRepository = defaultRepository
  }

  /** Adds complete discussion and lifecycle evidence to an already loaded issue. */
  async #issueEvidence(
    issue: IssueSummary,
    repository: string,
    relation: ReferencedIssueContext["relation"]
  ): Promise<ReferencedIssueContext> {
    const resolvedRepository = issue.repository || repository
    const [comments, timeline] = await Promise.all([
      this.#source.listIssueComments(issue.number, resolvedRepository),
      this.#source.listIssueTimeline(issue.number, resolvedRepository)
    ])
    return { relation, repository: resolvedRepository, issue, comments, timeline }
  }

  /** Loads one literal issue and returns rich evidence plus normalized context. */
  async issue(
    issueNumber: number,
    repository = this.#defaultRepository,
    relation: ReferencedIssueContext["relation"] = "referenced"
  ): Promise<{ evidence: ReferencedIssueContext; context: CompactIssueContext }> {
    const issue = await this.#source.getIssue(issueNumber, repository)
    const evidence = await this.#issueEvidence(issue, repository, relation)
    return { evidence, context: compactIssue(evidence) }
  }

  /**
   * Loads one complete PR context, including closing and explicitly related issues.
   *
   * The PR diff remains rich application evidence but only its file inventory is
   * included in the compact DTO; `get_pr_diff` owns the independently large patch.
   */
  async pullRequest(prNumber: number, repository = this.#defaultRepository): Promise<PullRequestEvidence> {
    // Fetch independent GitHub surfaces concurrently. GitHubReviewSession caches
    // only the endpoint reads; assembly below remains disposable application work.
    const [
      pullRequest,
      diff,
      commits,
      issueComments,
      closingIssues,
      reviewComments,
      reviews,
      timelineEvents,
      threadsResult
    ] = await Promise.all([
      this.#source.getPullRequest(prNumber, repository),
      this.#source.getPullRequestDiff(prNumber, repository),
      this.#source.listPullRequestCommits(prNumber, repository),
      this.#source.listPullRequestComments(prNumber, repository),
      this.#source.listPullRequestClosingIssues(prNumber, repository),
      this.#source.listReviewComments(prNumber, repository),
      this.#source.listReviews(prNumber, repository),
      this.#source.listPullRequestTimeline(prNumber, repository),
      this.#source.listReviewThreads(prNumber, repository)
    ])

    // GitHub closing references are authoritative. Explicit `related to` clauses
    // add context, but never weaken or duplicate an existing closing relationship.
    const closingKeys = new Set(closingIssues.map(issue => `${issue.repository || repository}#${issue.number}`))
    const related = parseRelatedIssueReferences(pullRequest.body || "", repository).filter(
      reference => !closingKeys.has(`${reference.repository}#${reference.number}`)
    )
    // `related to` clauses are enrichment-only: a clause naming a pull request
    // is skipped instead of failing the whole snapshot.
    const relatedIssues = (
      await Promise.all(
        related.map(async reference => {
          try {
            return await this.issue(reference.number, reference.repository, "related").then(result => result.evidence)
          } catch (error) {
            if (error instanceof NotAnIssueError) return null
            throw error
          }
        })
      )
    ).flatMap(evidence => (evidence ? [evidence] : []))
    const referencedIssues = await Promise.all([
      ...closingIssues.map(issue => this.#issueEvidence(issue, issue.repository || repository, "closes")),
      ...relatedIssues
    ])
    // Build history once before assembling the normalized application context.
    const history = buildPullRequestHistory({
      pullRequest,
      commits,
      issueComments,
      reviewComments,
      reviews,
      timelineEvents,
      threadsResult
    })
    // REST and GraphQL expose several equivalent field names. Normalize that
    // provider variation only at this boundary so every consumer sees one shape.
    const context: CompactPullRequestContext = {
      kind: "pull_request",
      repository,
      number: pullRequest.number,
      // REST's `url` is an API endpoint; Agents and exported documents need
      // the human-facing page when GitHub supplies both representations.
      url: pullRequest.html_url || pullRequest.url || null,
      title: pullRequest.title || "",
      description: pullRequest.body || "",
      state: pullRequest.state || null,
      author: pullRequest.author?.login || pullRequest.user?.login || null,
      labels: (pullRequest.labels || []).flatMap(label => (label.name ? [label.name] : [])),
      assignees: (pullRequest.assignees || []).flatMap(assignee => (assignee.login ? [assignee.login] : [])),
      createdAt: pullRequest.createdAt || pullRequest.created_at || null,
      updatedAt: pullRequest.updatedAt || pullRequest.updated_at || null,
      baseRefName: pullRequest.baseRefName || pullRequest.base?.ref || null,
      headRefName: pullRequest.headRefName || pullRequest.head?.ref || null,
      baseRefOid: pullRequest.baseRefOid || pullRequest.base?.sha || null,
      headRefOid: pullRequest.headRefOid || pullRequest.head?.sha || null,
      draft: Boolean(pullRequest.isDraft ?? pullRequest.draft),
      reviewDecision: pullRequest.reviewDecision || null,
      changedFiles: diff.files.map(file => file.path),
      ignoredFiles: diff.ignoredFiles,
      commits: commits.map(commit => ({
        sha: commit.sha || "unknown",
        url: commit.html_url || null,
        author: commit.author?.login || commit.committer?.login || commit.commit?.author?.name || null,
        at: commit.commit?.author?.date || commit.commit?.committer?.date || null,
        subject: compactContextText(String(commit.commit?.message || "").split(/\r?\n/u)[0])
      })),
      history,
      issues: referencedIssues.map(compactIssue)
    }

    return {
      repository,
      pullRequest,
      diff,
      issueComments,
      referencedIssues,
      reviewComments,
      reviews,
      timelineEvents,
      commits,
      threadsResult,
      context
    }
  }
}
