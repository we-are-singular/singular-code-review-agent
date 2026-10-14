import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { pipeline } from "node:stream/promises"

import type {
  GitHubClient,
  PullRequestSummary,
  IssueComment,
  PullRequestReview,
  PullRequestTimelineEvent,
  IssueTimelineEvent,
  Reaction,
  ReviewComment,
  ReviewThreadsResult
} from "./client.js"
import { GitHubContextService } from "./context.js"
import { CONTEXT_REFERENCE_BATCH_SIZE, contextReferenceSignature, selectRelatedReferences } from "./context-model.js"
import { ReviewEvidence } from "../review-evidence.js"
import { ReviewDiff } from "../../lib/review-diff.js"
import type { ReviewRequest, ReviewSnapshot } from "../../types/review.js"
import { REVIEW_DELETED_CONTENT_THRESHOLD } from "../../config.js"

const TRIGGER_TEXT_LIMIT = 1_600

/** Streams Git evidence to disk and settles process/stream failures together. */
async function writeGitOutput(args: string[], cwd: string, destination: string): Promise<void> {
  const output = createWriteStream(destination)
  const child = spawn("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  })
  const closed = once(child, "close")
  const written = pipeline(child.stdout, output)
  // Keep only the tail: git diagnostics can be long, and the full stream has
  // no value once the failure is reported.
  let errorText = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    errorText = (errorText + chunk).slice(-8_192)
  })

  let code: number | null
  try {
    // `once` also rejects on a spawn `error` (e.g. git missing), so a failed
    // start cannot leave the caller waiting on a stream that never ends.
    const [result] = await Promise.all([closed, written])
    ;[code] = result
  } catch (error) {
    child.kill()
    output.destroy()
    await Promise.allSettled([closed, written])
    throw new Error(`git diff failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (code !== 0) {
    const detail = errorText.trim()
    throw new Error(`git diff failed${detail ? `: ${detail}` : ""}`)
  }
}

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

  /** Loads complete evidence once, preserving full anchors when large PRs omit deleted bodies. */
  getPullRequestDiff(prNumber = this.#request.prNumber, repository = this.#request.repository): Promise<ReviewDiff> {
    return this.#once(`pull-request-diff:${repository}#${prNumber}`, async () => {
      // Only the active PR belongs to this checkout. Linked PRs still use GitHub.
      const active = prNumber === this.#request.prNumber && repository === this.#request.repository
      const pullRequest = active ? await this.getPullRequest() : null
      const compactDeletes =
        pullRequest !== null &&
        (pullRequest.additions || 0) + (pullRequest.deletions || 0) > REVIEW_DELETED_CONTENT_THRESHOLD
      if (pullRequest && compactDeletes) {
        try {
          const { rawDiff, modelDiff } = await this.#localDiff(pullRequest, true)
          return ReviewDiff.from(rawDiff, modelDiff)
        } catch (localError) {
          // Local reconstruction is an optimization for diffs GitHub often
          // refuses, not the only source of truth: a complete GitHub diff is
          // still complete evidence, just uncompacted. Only when GitHub also
          // fails is the local error the actionable one.
          try {
            return ReviewDiff.from(await this.#github.getPullRequestDiff(prNumber, repository))
          } catch {
            throw localError
          }
        }
      }

      try {
        return ReviewDiff.from(await this.#github.getPullRequestDiff(prNumber, repository))
      } catch (error) {
        // GitHub's diff limit includes context lines, so even a PR below our
        // changed-line threshold can need local retrieval without compaction.
        if (pullRequest && typeof error === "object" && error !== null && "status" in error && error.status === 406) {
          const { rawDiff } = await this.#localDiff(pullRequest, false)
          return ReviewDiff.from(rawDiff)
        }
        throw error
      }
    })
  }

  /** Reconstructs the frozen PR comparison locally, bypassing GitHub's large-diff limit. */
  async #localDiff(pullRequest: PullRequestSummary, compactDeletes: boolean) {
    const { baseRefOid, headRefOid } = pullRequest
    if (!baseRefOid || !headRefOid || headRefOid !== this.#request.workspaceHeadSha) {
      throw new Error("Cannot reconstruct the PR diff without pinned base and matching checkout head commits")
    }

    // Blank context markers drive anchor counters; user Git settings must not strip them.
    const args = [
      "-c",
      "diff.suppressBlankEmpty=false",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--find-renames",
      "--unified=3",
      "--src-prefix=a/",
      "--dst-prefix=b/"
    ]
    const range = `${baseRefOid}...${headRefOid}`
    const directory = await mkdtemp(join(tmpdir(), "singular-code-review-diff-"))
    const rawPath = join(directory, "raw.diff")
    const modelPath = join(directory, "model.diff")
    try {
      const rawOutput = writeGitOutput([...args, range, "--"], this.#request.workspace, rawPath)
      const modelOutput = compactDeletes
        ? writeGitOutput([...args, "--irreversible-delete", range, "--"], this.#request.workspace, modelPath)
        : Promise.resolve()
      // Both children must stop before removing their directory, including
      // when one fails while the other is still writing its diff.
      const outputs = await Promise.allSettled([rawOutput, modelOutput])
      for (const output of outputs) {
        if (output.status === "rejected") throw output.reason
      }
      const rawDiff = await readFile(rawPath, "utf8")
      if (!compactDeletes) return { rawDiff }
      return { rawDiff, modelDiff: await readFile(modelPath, "utf8") }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  /** Resolves an issue explicitly referenced by review evidence. */
  getIssue(issueNumber: number, repository = this.#request.repository) {
    return this.#once(`issue:${repository}#${issueNumber}`, () => this.#github.getIssue(issueNumber, repository))
  }

  /** Resolves a numbered reference without assuming it names an issue. */
  getIssueOrPullRequest(number: number, repository = this.#request.repository) {
    return this.#once(`reference:${repository}#${number}`, () => this.#github.getIssueOrPullRequest(number, repository))
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
    // can change both stated intent and the reference set without changing the head.
    if (String(current.body || "") !== snapshot.context.description) {
      throw new Error("pull request description or reference set changed during review; run the review again")
    }

    // Re-resolve GitHub-native closing references and explicit related clauses.
    // Relationship type is part of the signature because `closes` is a claimed
    // contract while `related` is enrichment only.
    const closingIssues = await this.#github.listPullRequestClosingIssues(
      this.#request.prNumber,
      this.#request.repository
    )
    const related = selectRelatedReferences({
      body: current.body || "",
      repository: this.#request.repository,
      prNumber: this.#request.prNumber,
      closingIssues
    })
    // Resolve through the same union as gathering, but bypass the session cache.
    // PR pushes can change the head even when updatedAt has not advanced yet.
    const latestRelated: string[] = []
    // Freshness must retain the gathering bound even for a long reference list.
    for (let start = 0; start < related.length; start += CONTEXT_REFERENCE_BATCH_SIZE) {
      latestRelated.push(
        ...(await Promise.all(
          related.slice(start, start + CONTEXT_REFERENCE_BATCH_SIZE).map(async reference => {
            const resolved = await this.#github.getIssueOrPullRequest(reference.number, reference.repository)
            if (resolved.kind === "issue") {
              const issue = resolved.issue
              return contextReferenceSignature({
                kind: "issue",
                relation: "related",
                repository: issue.repository || reference.repository,
                number: issue.number,
                updatedAt: issue.updated_at || null
              })
            }
            const pr = resolved.pullRequest
            return contextReferenceSignature({
              kind: "pull_request",
              relation: "related",
              repository: reference.repository,
              number: pr.number,
              updatedAt: pr.updatedAt || null,
              headRefOid: pr.headRefOid || null
            })
          })
        ))
      )
    }
    const latestReferences = [
      ...closingIssues.map(issue =>
        contextReferenceSignature({
          kind: "issue",
          relation: "closes",
          repository: issue.repository || this.#request.repository,
          number: issue.number,
          updatedAt: issue.updated_at || null
        })
      ),
      ...latestRelated
    ].toSorted()
    const reviewedReferences = [...snapshot.context.issues, ...snapshot.context.pullRequests]
      .map(contextReferenceSignature)
      .toSorted()

    // Issue `updatedAt` covers body, comment, and lifecycle changes without
    // replaying every compact history event solely for a freshness comparison.
    if (JSON.stringify(latestReferences) !== JSON.stringify(reviewedReferences)) {
      throw new Error("referenced issue or pull request context changed during review; run the review again")
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
