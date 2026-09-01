import { fileURLToPath } from "node:url"

import { AmlRuntime, localWorkspace, ParallelError } from "@aml-jsx/sdk"

import { ReviewContext, ReviewOutcome, ReviewRouting, type ReviewContextValue } from "./components/review-context.js"
import { createReviewProvider } from "./lib/review-provider.js"
import type { PublishedReview, ReviewAttempt, ReviewRequest, ReviewRunResult } from "./types/review.js"
import { REVIEW_LANE_NAMES, ReviewQueue } from "./lib/review-queue.js"
import { ReviewTelemetryCollector } from "./lib/review-telemetry.js"
import { Review } from "./review.js"
import { ReviewGitHubActions, type GitHubActionMode } from "./services/github-actions.js"
import type { GitHubClient } from "./services/github-client.js"
import { GitHubReviewSession } from "./services/github-session.js"

export type ReviewRuntimeOptions = {
  request: ReviewRequest
  github: GitHubClient
  actionMode: GitHubActionMode
  model: string
  reviewEmojis?: boolean
  maximumConcurrency: number
  progress?: (line: string) => unknown
  signal?: AbortSignal
}

const REVIEW_PROVIDER = "opencode"

/** Preserves provider causes and names failed parallel lanes at the CLI boundary. */
function errorMessage(error: unknown): string {
  if (error instanceof ParallelError) {
    return error.failures
      .map(failure => {
        const lane = REVIEW_LANE_NAMES[failure.branchIndex] || `branch ${failure.branchIndex + 1}`
        return `${lane}: ${errorMessage(failure.cause)}`
      })
      .join("; ")
  }
  if (!(error instanceof Error)) {
    return String(error)
  }
  if (error.cause instanceof Error && error.cause.message !== error.message) {
    return `${error.message}: ${errorMessage(error.cause)}`
  }
  return error.message
}

/** Runs one AML review in memory, then publishes exactly its selected draft. */
export async function runReview(
  options: ReviewRuntimeOptions,
  createProvider: typeof createReviewProvider = createReviewProvider
): Promise<ReviewRunResult> {
  const started = Date.now()
  const signal = options.signal || new AbortController().signal
  const telemetry = new ReviewTelemetryCollector({ ...(options.progress ? { progress: options.progress } : {}) })
  const github = new GitHubReviewSession(options.github, options.request, options.actionMode === "live")
  const snapshot = await github.snapshot()
  const pullRequestHead = snapshot.pullRequest.headRefOid
  if (!pullRequestHead || options.request.workspaceHeadSha !== pullRequestHead) {
    throw new Error(
      `checked-out head ${options.request.workspaceHeadSha} does not match pull request head ${pullRequestHead || "unknown"}`
    )
  }
  // PR metadata and diff are separate GitHub reads. Confirm the head once more
  // after snapshot assembly so a push between those reads cannot reach Agents.
  await github.assertHeadUnchanged()
  const actions = new ReviewGitHubActions({
    mode: options.actionMode,
    github: options.github,
    repository: options.request.repository,
    prNumber: options.request.prNumber,
    headSha: snapshot.pullRequest.headRefOid || null
  })
  const outcome = new ReviewOutcome()
  const reviewContext: ReviewContextValue = {
    github,
    actions,
    queue: new ReviewQueue({
      botLogin: snapshot.botLogin,
      commentRanges: snapshot.diff.commentRanges,
      reviewEmojis: options.reviewEmojis !== false,
      reviewThreadsAvailable: snapshot.reviewThreadsAvailable,
      unresolvedBotThreads: snapshot.unresolvedBotThreads,
      reviewComments: snapshot.reviewComments
    }),
    routing: new ReviewRouting(),
    snapshot,
    outcome,
    model: options.model
  }
  const attempts: ReviewAttempt[] = []
  const startedAt = new Date().toISOString()
  let selected: { review: PublishedReview; publicationError: string | null } | null = null
  try {
    const provider = createProvider({
      model: options.model,
      workspace: options.request.workspace
    })
    const runtime = new AmlRuntime({
      agentProvider: provider,
      // Application-owned Include sources resolve beside the compiled reviewer while the provider
      // remains pinned to the repository under review.
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      maxConcurrentAgents: options.maximumConcurrency,
      // The post-order review tree nests lane Agents beneath audit, synthesis,
      // the router, and Workspace while retaining a finite depth budget.
      maxDepth: 24,
      workspaceProvider: localWorkspace({ directory: options.request.workspace }),
      trace: telemetry.trace
    })
    await runtime.evaluate(
      <ReviewContext.Provider value={reviewContext}>
        <Review />
      </ReviewContext.Provider>,
      { signal }
    )
    attempts.push({
      number: 1,
      provider: REVIEW_PROVIDER,
      model: options.model,
      status: "completed",
      startedAt,
      endedAt: new Date().toISOString(),
      error: null
    })
    selected = outcome.result()
  } catch (error) {
    attempts.push({
      number: 1,
      provider: REVIEW_PROVIDER,
      model: options.model,
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      error: errorMessage(error)
    })
  }

  if (!selected) {
    const failures = attempts.map(attempt => `attempt ${attempt.number}: ${attempt.error}`).join("; ")
    throw new Error(`review unsuccessful: ${failures}`)
  }

  return {
    ...selected.review,
    generatedAt: new Date().toISOString(),
    repository: options.request.repository,
    prNumber: options.request.prNumber,
    provider: REVIEW_PROVIDER,
    model: options.model,
    attempts,
    durationMs: Date.now() - started,
    usage: telemetry.usage(),
    traceSummaries: telemetry.summaries(),
    providerCompletions: telemetry.providerCompletions(),
    publication: actions.receipts(),
    publicationStatus: selected.publicationError ? "failed" : "completed",
    publicationError: selected.publicationError
  }
}
