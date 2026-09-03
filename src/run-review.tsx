import { fileURLToPath } from "node:url"

import { AmlRuntime, localWorkspace, ParallelError } from "@aml-jsx/sdk"

import { createReviewContextEnvironment, ReviewContextProvider } from "./components/context/review-context.js"
import { createReviewProvider } from "./lib/review-provider.js"
import type { PublishedReview, ReviewAttempt, ReviewRequest, ReviewRunResult } from "./types/review.js"
import { REVIEW_LANE_NAMES } from "./lib/review-queue.js"
import { ReviewTelemetryCollector } from "./lib/review-telemetry.js"
import { Review } from "./review.js"
import type { GitHubActionMode } from "./services/github/actions.js"
import type { GitHubClient } from "./services/github/client.js"

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

/** Signals that no publishable review exists, so an outer model fallback may start safely. */
export class ReviewUnavailableError extends Error {
  override readonly name = "ReviewUnavailableError"
}

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
  // Context construction owns request-scoped GitHub and publication services;
  // the runner retains one environment only to collect their terminal outputs.
  const environment = createReviewContextEnvironment({
    github: options.github,
    request: options.request,
    actionMode: options.actionMode,
    model: options.model,
    reviewEmojis: options.reviewEmojis !== false
  })
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
      <ReviewContextProvider environment={environment}>
        <Review />
      </ReviewContextProvider>,
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
    selected = environment.outcome.result()
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
    throw new ReviewUnavailableError(`review unsuccessful: ${failures}`)
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
    publication: environment.actions.receipts(),
    publicationStatus: selected.publicationError ? "failed" : "completed",
    publicationError: selected.publicationError
  }
}
