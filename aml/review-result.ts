import type { TraceSummary } from "@aml-jsx/sdk"

import type { PullRequestSummary } from "../src/clients/github.js"
import type {
  ReviewContext,
  ReviewPayload,
  ReviewerContext,
  ReviewValidationContext,
  ValidatedReviewQueue
} from "../src/review/types.js"
import type { AuditedReview } from "./phases/review-audit.js"
import type { ReviewGateResult } from "./phases/review-gate.js"
import type { GitHubActionReceipt } from "./services/github-actions.js"
import type { LaneAssessment } from "./services/review-findings.js"
import type { ReviewUsage } from "./telemetry.js"

export type ReviewRequest = {
  repository: string
  prNumber: number
  workspace: string
  botLogin: string
  eventName: string | null
  eventPath: string | null
  actor: string | null
  ignoreHistory: boolean
}

/** Immutable input assembled once from cached GitHub reads for one PR head. */
export type ReviewSnapshot = {
  pullRequest: PullRequestSummary
  context: ReviewContext
  reviewerContext: ReviewerContext
  validationContext: ReviewValidationContext
  diff: string
}

export type ReviewedDraft = {
  status: "reviewed"
  gate: Extract<ReviewGateResult, { decision: "review" }>
  lanes: LaneAssessment[]
  audit: AuditedReview
  validated: ValidatedReviewQueue
  body: string
}

export type GateDraft = {
  status: "answered" | "no-review"
  gate: Extract<ReviewGateResult, { decision: "answer" | "no-review" }>
  body: string
}

export type ReviewDraft = ReviewedDraft | GateDraft

export type PublishedReview = (ReviewedDraft & { payload: ReviewPayload }) | GateDraft

export type ReviewAttempt = {
  number: number
  provider: string
  model: string
  status: "completed" | "failed"
  startedAt: string
  endedAt: string
  error: string | null
}

type ReviewRunMetadata = {
  generatedAt: string
  repository: string
  prNumber: number
  provider: string
  model: string
  durationMs: number
  attempts: ReviewAttempt[]
  usage: ReviewUsage
  traceSummaries: readonly TraceSummary[]
  publication: GitHubActionReceipt[]
  publicationStatus: "completed" | "failed"
  publicationError: string | null
}

export type ReviewedRunResult = Extract<PublishedReview, { status: "reviewed" }> & ReviewRunMetadata
export type GateRunResult = Extract<PublishedReview, { status: "answered" | "no-review" }> & ReviewRunMetadata

/** One typed in-memory result consumed by the CLI and eval exporter. */
export type ReviewRunResult = ReviewedRunResult | GateRunResult
