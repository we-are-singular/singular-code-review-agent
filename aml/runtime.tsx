import { fileURLToPath } from "node:url"

import {
  AmlRuntime,
  localWorkspace,
  ParallelError,
  type AgentProvider,
  type SandboxProvider,
  type TraceSink
} from "@aml-jsx/sdk"

import { createAmlReviewProvider, type AmlReviewProvider } from "./providers.js"
import { ReviewContext, ReviewOutcome, type ReviewContextValue } from "./review-context.js"
import { Review } from "./review.js"
import { ReviewGitHubActions, type GitHubActionMode } from "./services/github-actions.js"
import type { AmlGitHubClient } from "./services/github-client.js"
import { REVIEW_LANES, ReviewFindings } from "./services/review-findings.js"
import { GitHubReviewSession } from "./services/github-session.js"
import { ReviewTelemetryCollector } from "./telemetry.js"
import type { PublishedReview, ReviewAttempt, ReviewRequest, ReviewRunResult } from "./review-result.js"

export type ReviewRuntimeOptions = {
  request: ReviewRequest
  github: AmlGitHubClient
  actionMode: GitHubActionMode
  provider: AmlReviewProvider
  model: string
  codexHome?: string
  sandboxProvider?: SandboxProvider
  maximumConcurrency: number
  signal?: AbortSignal
}

/** Preserves a provider's concrete failure beneath AML's authored Agent label. */
function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  if (error.cause instanceof Error && error.cause.message !== error.message) {
    return `${error.message}: ${errorMessage(error.cause)}`
  }
  return error.message
}

/** Adds authored lane names at the one user-facing error boundary. */
function reviewError(error: unknown): string {
  if (!(error instanceof ParallelError)) {
    return errorMessage(error)
  }

  return error.failures
    .map(failure => {
      const lane = REVIEW_LANES[failure.branchIndex] || `branch ${failure.branchIndex + 1}`
      return `${lane}: ${errorMessage(failure.cause)}`
    })
    .join("; ")
}

/** Creates one fresh provider runtime for the complete review and publication tree. */
function runtime(options: {
  provider: AgentProvider
  sandboxProvider?: SandboxProvider
  workspace: string
  concurrency: number
  trace: TraceSink
}): AmlRuntime {
  return new AmlRuntime({
    agentProvider: options.provider,
    // Skill paths resolve beside the authored AML package while provider
    // working directories remain pinned to the repository under review.
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    maxConcurrentAgents: options.concurrency,
    maxTurnsPerAgent: 1,
    workspaceProvider: localWorkspace({ directory: options.workspace }),
    ...(options.sandboxProvider ? { sandboxProvider: options.sandboxProvider } : {}),
    trace: options.trace
  })
}

/** Runs one AML review in memory, then publishes exactly its selected draft. */
export async function runReview(
  options: ReviewRuntimeOptions,
  createProvider: typeof createAmlReviewProvider = createAmlReviewProvider
): Promise<ReviewRunResult> {
  const started = Date.now()
  const signal = options.signal || new AbortController().signal
  const telemetry = new ReviewTelemetryCollector()
  const github = new GitHubReviewSession(options.github, options.request)
  const snapshot = await github.snapshot()
  const actions = new ReviewGitHubActions({
    mode: options.actionMode,
    github: options.github,
    repository: options.request.repository,
    prNumber: options.request.prNumber,
    headSha: snapshot.reviewerContext.pr.head_sha
  })
  const outcome = new ReviewOutcome()
  const reviewContext: ReviewContextValue = {
    github,
    actions,
    findings: new ReviewFindings(snapshot.validationContext),
    snapshot,
    outcome,
    model: options.model
  }
  const attempts: ReviewAttempt[] = []
  const startedAt = new Date().toISOString()
  let selected: { review: PublishedReview; publicationError: string | null } | null = null
  try {
    const provider = createProvider({
      provider: options.provider,
      model: options.model,
      workspace: options.request.workspace,
      ...(options.codexHome ? { codexHome: options.codexHome } : {})
    })
    const attemptRuntime = runtime({
      provider,
      ...(options.sandboxProvider ? { sandboxProvider: options.sandboxProvider } : {}),
      workspace: options.request.workspace,
      concurrency: options.maximumConcurrency,
      trace: telemetry.trace
    })
    await attemptRuntime.evaluate(
      <ReviewContext.Provider value={reviewContext}>
        <Review
          sandboxed={Boolean(options.sandboxProvider)}
          workspaceId={`${options.request.repository.replaceAll("/", "-")}-pr-${options.request.prNumber}`}
        />
      </ReviewContext.Provider>,
      { signal }
    )
    attempts.push({
      number: 1,
      provider: options.provider,
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
      provider: options.provider,
      model: options.model,
      status: "failed",
      startedAt,
      endedAt: new Date().toISOString(),
      error: reviewError(error)
    })
  }

  if (!selected) {
    const failures = attempts.map(attempt => `attempt ${attempt.number}: ${attempt.error}`).join("; ")
    throw new Error(`AML review unsuccessful: ${failures}`)
  }

  const base = {
    generatedAt: new Date().toISOString(),
    repository: options.request.repository,
    prNumber: options.request.prNumber,
    provider: options.provider,
    model: options.model,
    attempts
  }

  return {
    ...selected.review,
    ...base,
    durationMs: Date.now() - started,
    usage: telemetry.usage(),
    traceSummaries: telemetry.summaries(),
    publication: actions.receipts(),
    publicationStatus: selected.publicationError ? "failed" : "completed",
    publicationError: selected.publicationError
  }
}
