import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs"
import { isAbsolute, relative } from "node:path"
import { type GitHubClient } from "../clients/github.js"
import { OpenCodeRunError, type OpenCodeClient, type OpenCodeRunResult } from "../clients/opencode.js"
import { type RunnerConfig } from "../config/env.js"
import { type ArtifactPaths, type ArtifactStore } from "../lib/artifacts.js"
import { type Logger } from "../lib/logger.js"
import { buildAuditPrompt, buildGatePrompt, buildReviewPrompt, buildSynthesisPrompt } from "../prompts/prompts.js"
import { applyReviewBanner, buildReviewPayload, enforceReviewBodyLimit } from "./body.js"
import { buildAuditorContext, buildReviewContext, buildReviewerContext, buildValidationContext } from "./context.js"
import { parseGateDecision, prepareGate } from "./gate.js"
import { clearQueue, loadQueue, persistValidation, saveQueue, setConclusion, validateQueue } from "./queue.js"
import { type GateContext, type GateDecision, type ReviewContext, type ValidatedReviewQueue } from "./types.js"

/**
 * Stable phase names for logs, tests, and future workflow documentation.
 * These names describe the product flow, not implementation details.
 */
export const REVIEW_WORKFLOW_PHASES = ["gathering", "gate", "review", "audit", "synthesis"] as const

export type ReviewWorkflowPhase = (typeof REVIEW_WORKFLOW_PHASES)[number]

export type ReviewWorkflowDependencies = {
  config: RunnerConfig
  artifacts: ArtifactStore
  github: GitHubClient
  opencode: OpenCodeClient
  logger: Logger
}

export type ReviewWorkflowResult =
  | {
      status: "skipped"
      reason: string
    }
  | {
      status: "answered" | "no-review"
      reason: string
    }
  | {
      status: "dry-run" | "submitted"
      inlineComments: number
      replies: number
      payloadFile: string
      validatedFile: string
    }

type OpenCodeReviewPaths = {
  gateContextPath: string
  gateDeltaPath: string
  reviewContextPath: string
  auditorContextPath: string
  diffPath: string
  queuePath: string
  validatedPath: string
  reviewOutputPath: string
}

type ReviewWorkflowState = ReviewWorkflowDependencies & {
  paths: ArtifactPaths
  opencodePaths: OpenCodeReviewPaths
}

const REVIEW_PERMISSION_DENIAL_RESUME_INSTRUCTION =
  "Resume the prior review. The previous attempt was interrupted by a sandbox permission denial. Do not repeat the denied access. Use workspace-relative repository paths and use `/tmp/.singular-code-review` only for temporary files; do not access `/tmp` itself or other external directories. Complete the review."

function queueHasReviewActions(queueFile: string): boolean {
  const queue = loadQueue(queueFile)
  return queue.inlineComments.length > 0 || queue.replies.length > 0
}

function reviewerOutputSeemsComplete(reviewText: string): boolean {
  return (
    /\b(?:verdict|LGTM|looks good|ready to merge|request changes?|block:)\b/iu.test(reviewText) ||
    /\b(?:no|not any|did not find|didn't find)\s+(?:valid\s+|blocking\s+|actionable\s+)?(?:issues?|findings?|problems?|concerns?)\b/iu.test(
      reviewText
    ) ||
    /\bnothing\s+(?:actionable|blocking|merge-blocking)\b/iu.test(reviewText)
  )
}

function reviewerOutputShowsPermissionDenial(reviewText: string): boolean {
  return /(?:permission requested:|auto-rejecting|external_directory|permission denied|tool access issue)/iu.test(
    reviewText
  )
}

function fallbackConclusion(hasInlineComments: boolean): string {
  if (hasInlineComments) {
    return "The inline review comments identify the changes that need attention.\n\n## Verdict\n\n⚠️ Request changes: address the inline review comments."
  }

  return "## Verdict\n\n❓ Incomplete review: the final review summary could not be generated."
}

/**
 * Prefer workspace-relative attachment paths so OpenCode can display useful
 * file names, while still supporting runtime artifacts outside the checkout.
 */
function pathForOpenCode(workspace: string, file: string): string {
  const relativePath = relative(workspace, file)
  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath
  }
  return file
}

function buildOpenCodeReviewPaths(config: RunnerConfig, paths: ArtifactPaths): OpenCodeReviewPaths {
  return {
    gateContextPath: pathForOpenCode(config.workspace, paths.gateContextFile),
    gateDeltaPath: pathForOpenCode(config.workspace, paths.gateDeltaFile),
    reviewContextPath: pathForOpenCode(config.workspace, paths.reviewerContextFile),
    auditorContextPath: pathForOpenCode(config.workspace, paths.auditorContextFile),
    diffPath: pathForOpenCode(config.workspace, paths.diffFile),
    queuePath: pathForOpenCode(config.workspace, paths.queueFile),
    validatedPath: pathForOpenCode(config.workspace, paths.validatedFile),
    reviewOutputPath: pathForOpenCode(config.workspace, paths.reviewOutputFile)
  }
}

function createReviewWorkflowState(deps: ReviewWorkflowDependencies): ReviewWorkflowState {
  const paths = deps.artifacts.paths
  return {
    ...deps,
    paths,
    opencodePaths: buildOpenCodeReviewPaths(deps.config, paths)
  }
}

function clearStaleRunState(paths: ArtifactPaths): void {
  rmSync(paths.gateResultFile, { force: true })
  rmSync(paths.reviewSessionFile, { force: true })
}

/**
 * Exposes artifact paths to the agent-facing CLI tools invoked by OpenCode.
 * This is the process-level bridge between the runner and `review_comments`.
 */
function exposeReviewArtifactsToTools(config: RunnerConfig, paths: ArtifactPaths): void {
  process.env.REVIEW_QUEUE_FILE = paths.queueFile
  process.env.REVIEW_VALIDATION_CONTEXT_FILE = paths.contextFile
  process.env.GATE_MODEL_CONTEXT_FILE = paths.gateContextFile
  process.env.GATE_DELTA_FILE = paths.gateDeltaFile
  process.env.REVIEW_MODEL_CONTEXT_FILE = paths.reviewerContextFile
  process.env.AUDIT_MODEL_CONTEXT_FILE = paths.auditorContextFile
  process.env.REVIEW_DIFF_FILE = paths.diffFile
  process.env.OPENCODE_MODEL = config.model
}

function logPhase(
  logger: Logger,
  phase: ReviewWorkflowPhase,
  message: string,
  context?: Record<string, unknown>
): void {
  logger.info(`${phase}: ${message}`, context)
}

/**
 * Gathers every durable input the later phases need: PR metadata, diff ranges,
 * optional PR history, trigger context, and bot history.
 */
async function runGatheringPhase(state: ReviewWorkflowState): Promise<ReviewContext> {
  const { config, github, artifacts, paths, logger } = state

  logPhase(logger, "gathering", "building review context", {
    repository: config.repository,
    pr: config.prNumber
  })

  const context = await buildReviewContext({
    github,
    repository: config.repository,
    prNumber: config.prNumber,
    diffFile: paths.diffFile,
    timelineFile: paths.timelineFile,
    eventName: config.eventName,
    eventPath: config.eventPath,
    actor: config.actor,
    botLogin: config.botLogin,
    ignoreHistory: config.ignoreHistory
  })

  artifacts.writeJson(paths.contextFile, buildValidationContext(context))
  artifacts.writeJson(paths.reviewerContextFile, buildReviewerContext(context))
  artifacts.writeJson(paths.auditorContextFile, buildAuditorContext(context))
  return context
}

/**
 * Runs the only exploratory OpenCode phase. This phase may inspect the
 * repository and queue structured findings through the review tools.
 */
type ReviewAttempt = {
  number: number
  model: string
  variant: string | null
}

type ReviewAttemptRecord = {
  attempt: number
  model: string
  variant: string | null
  session_id: string | null
  finish_reason: string | null
  successful: boolean
  error: string | null
  output_file: string
  jsonl_file: string
  session_file: string
  permission_resume: Omit<ReviewAttemptRecord, "permission_resume"> | null
}

function reviewAttempts(config: RunnerConfig): ReviewAttempt[] {
  return [
    { number: 1, model: config.model, variant: config.modelVariant },
    { number: 2, model: config.model, variant: config.modelVariant },
    { number: 3, model: config.fallbackModel, variant: config.fallbackModelVariant }
  ]
}

function attemptFile(state: ReviewWorkflowState, attempt: number, name: string): string {
  return state.artifacts.child(`review-attempt-${attempt}/${name}`)
}

async function runReviewPhase(
  state: ReviewWorkflowState,
  attempt: ReviewAttempt,
  resumePermissionDenial = false
): Promise<OpenCodeRunResult> {
  const { config, opencode, paths, opencodePaths, logger } = state
  const outputFile = attemptFile(
    state,
    attempt.number,
    resumePermissionDenial ? "opencode_review_permission_resume.log" : "opencode_review.log"
  )
  const sessionFile = attemptFile(state, attempt.number, "session.txt")
  state.artifacts.ensureParent(outputFile)

  clearQueue(paths.queueFile)
  logPhase(logger, "review", resumePermissionDenial ? "resuming after permission denial" : "running OpenCode", {
    attempt: attempt.number,
    model: attempt.model,
    fresh_session: attempt.number > 1 && !resumePermissionDenial,
    reuse_session: resumePermissionDenial
  })

  return opencode.run({
    workspace: config.workspace,
    outputFile,
    jsonOutputFile: `${outputFile}.jsonl`,
    capabilitiesFile: paths.opencodeCapabilitiesFile,
    sessionFile,
    reuseSession: resumePermissionDenial,
    agent: "reviewer",
    model: attempt.model,
    variant: attempt.variant ?? undefined,
    files: [opencodePaths.reviewContextPath, opencodePaths.diffPath],
    prompt: buildReviewPrompt({
      contextFile: opencodePaths.reviewContextPath,
      diffFile: opencodePaths.diffPath,
      resumeInstruction: resumePermissionDenial ? REVIEW_PERMISSION_DENIAL_RESUME_INSTRUCTION : undefined
    })
  })
}

function reviewAttemptSucceeded(result: OpenCodeRunResult, validation: ValidatedReviewQueue): boolean {
  const hasFindings = validation.stats.queued_inline > 0 || validation.stats.queued_replies > 0
  const hasTerminalVerdict = reviewerOutputSeemsComplete(result.text)
  return (
    typeof result.finishReason === "string" && result.finishReason !== "unknown" && (hasFindings || hasTerminalVerdict)
  )
}

function preserveSelectedReviewAttempt(state: ReviewWorkflowState, attempt: ReviewAttempt): void {
  const resumedOutputFile = attemptFile(state, attempt.number, "opencode_review_permission_resume.log")
  const outputFile = existsSync(resumedOutputFile)
    ? resumedOutputFile
    : attemptFile(state, attempt.number, "opencode_review.log")
  const jsonlFile = `${outputFile}.jsonl`
  const sessionFile = attemptFile(state, attempt.number, "session.txt")
  if (existsSync(outputFile)) {
    copyFileSync(outputFile, state.paths.reviewOutputFile)
  }
  if (existsSync(jsonlFile)) {
    copyFileSync(jsonlFile, `${state.paths.reviewOutputFile}.jsonl`)
  }
  if (existsSync(sessionFile)) {
    copyFileSync(sessionFile, state.paths.reviewSessionFile)
  }
}

async function executeReviewAttempt(
  state: ReviewWorkflowState,
  context: ReviewContext,
  attempt: ReviewAttempt,
  resumePermissionDenial = false
): Promise<{
  result: OpenCodeRunResult
  validation: ValidatedReviewQueue
  errorMessage: string | null
  record: Omit<ReviewAttemptRecord, "permission_resume">
}> {
  let result: OpenCodeRunResult
  let errorMessage: string | null = null
  try {
    result = await runReviewPhase(state, attempt, resumePermissionDenial)
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error)
    result =
      error instanceof OpenCodeRunError ? error.result : { text: "", sessionId: null, finishReason: null, args: [] }
  }

  const validation = validateCurrentQueue(
    state,
    context,
    "review",
    `attempt ${attempt.number}${resumePermissionDenial ? " permission resume" : ""} finding validation`
  )
  const outputName = resumePermissionDenial ? "opencode_review_permission_resume.log" : "opencode_review.log"
  const outputFile = attemptFile(state, attempt.number, outputName)
  return {
    result,
    validation,
    errorMessage,
    record: {
      attempt: attempt.number,
      model: attempt.model,
      variant: attempt.variant,
      session_id: result.sessionId,
      finish_reason: result.finishReason,
      successful: errorMessage === null && reviewAttemptSucceeded(result, validation),
      error: errorMessage,
      output_file: outputFile,
      jsonl_file: `${outputFile}.jsonl`,
      session_file: attemptFile(state, attempt.number, "session.txt")
    }
  }
}

async function runReviewAttempts(
  state: ReviewWorkflowState,
  context: ReviewContext
): Promise<{ reviewPass: OpenCodeRunResult; validation: ValidatedReviewQueue; attempt: ReviewAttempt }> {
  const records: ReviewAttemptRecord[] = []

  for (const attempt of reviewAttempts(state.config)) {
    const initialExecution = await executeReviewAttempt(state, context, attempt)
    let execution = initialExecution
    let permissionResume: Omit<ReviewAttemptRecord, "permission_resume"> | null = null
    const reviewText = [
      execution.result.text,
      existsSync(execution.record.output_file) ? readFileSync(execution.record.output_file, "utf8") : ""
    ].join("\n")

    if (!execution.record.successful && execution.result.sessionId && reviewerOutputShowsPermissionDenial(reviewText)) {
      state.logger.warn("review: permission denial interrupted the pass; resuming the same session with guidance")
      execution = await executeReviewAttempt(state, context, attempt, true)
      permissionResume = execution.record
    }

    const record: ReviewAttemptRecord = {
      ...initialExecution.record,
      successful: execution.record.successful,
      permission_resume: permissionResume
    }
    records.push(record)
    state.artifacts.writeJson(state.artifacts.child("review_attempts.json"), records)

    if (execution.record.successful) {
      preserveSelectedReviewAttempt(state, attempt)
      return { reviewPass: execution.result, validation: execution.validation, attempt }
    }

    state.logger.warn("review: attempt incomplete; retrying with a fresh session", record)
  }

  clearQueue(state.paths.queueFile)
  throw new Error("review unsuccessful: all three OpenCode attempts failed or produced incomplete output")
}

function gateContextForPrompt(context: GateContext, gateDeltaPath: string): GateContext {
  return {
    ...context,
    delta: {
      ...context.delta,
      file: gateDeltaPath
    }
  }
}

function formatGateAnswer(decision: Extract<GateDecision, { decision: "answer" | "no-review" }>): string {
  const answer = decision.answer.trim()
  if (decision.decision !== "no-review") {
    return answer
  }

  const withoutExistingVerdict = answer.replace(/\n{2,}✅\s*LGTM\.?\s*$/u, "").trim()
  return withoutExistingVerdict ? `${withoutExistingVerdict}\n\n✅ LGTM` : "✅ LGTM"
}

async function postGateAnswer(
  state: ReviewWorkflowState,
  decision: Extract<GateDecision, { decision: "answer" | "no-review" }>
): Promise<ReviewWorkflowResult> {
  const answer = formatGateAnswer(decision)
  await state.github.createIssueComment(state.config.prNumber, answer)
  const status = decision.decision === "answer" ? "answered" : "no-review"
  state.artifacts.writeJson(state.paths.gateResultFile, {
    generated_at: new Date().toISOString(),
    decision: decision.decision,
    status,
    answer
  })
  state.logger.info(`gate: posted ${status} comment`)
  return {
    status,
    reason: answer
  }
}

/**
 * Runs the cheap routing gate for synchronize/comment triggers. Any invalid or
 * uncertain outcome deliberately falls through to the normal full review.
 */
async function runGatePhase(
  state: ReviewWorkflowState,
  context: ReviewContext,
  diffText: string
): Promise<ReviewWorkflowResult | null> {
  const { config, opencode, artifacts, paths, opencodePaths, logger } = state
  const prepared = prepareGate({
    context,
    workspace: config.workspace,
    diffText,
    botLogin: config.botLogin
  })

  if (prepared.action === "run-review") {
    const logContext: Record<string, unknown> = { reason: prepared.reason }
    if (prepared.reason === "no previous bot review") {
      const matchingBotReviews = context.reviews.filter(review => review.user?.login === config.botLogin)
      const anchoredBotReviews = matchingBotReviews.filter(review => review.commit_id || review.commitId)
      Object.assign(logContext, {
        bot_login: config.botLogin,
        total_reviews: context.reviews.length,
        matching_bot_reviews: matchingBotReviews.length,
        anchored_bot_reviews: anchoredBotReviews.length
      })
    }

    logPhase(logger, "gate", "skipped; running full review", logContext)
    return null
  }

  const gateContext = gateContextForPrompt(prepared.context, opencodePaths.gateDeltaPath)
  artifacts.writeText(paths.gateDeltaFile, prepared.deltaText)
  artifacts.writeJson(paths.gateContextFile, gateContext)

  if (prepared.action === "post") {
    logPhase(logger, "gate", "resolved without OpenCode", { decision: prepared.decision.decision })
    return postGateAnswer(state, prepared.decision)
  }

  logPhase(logger, "gate", "running OpenCode", {
    model: config.gateModel,
    delta_mode: gateContext.delta.mode
  })

  let gateRun: OpenCodeRunResult
  try {
    gateRun = await opencode.run({
      workspace: config.workspace,
      outputFile: paths.gateOutputFile,
      jsonOutputFile: `${paths.gateOutputFile}.jsonl`,
      capabilitiesFile: paths.opencodeCapabilitiesFile,
      sessionFile: paths.gateSessionFile,
      agent: "gate",
      model: config.gateModel,
      variant: config.gateModelVariant ?? undefined,
      files: [opencodePaths.gateContextPath, opencodePaths.gateDeltaPath],
      prompt: buildGatePrompt({
        contextFile: opencodePaths.gateContextPath,
        deltaFile: opencodePaths.gateDeltaPath
      })
    })
  } catch (error) {
    logger.warn("gate: OpenCode failed; running full review", {
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }

  let decision: GateDecision
  try {
    decision = parseGateDecision(gateRun.text)
  } catch (error) {
    logger.warn("gate: invalid output; running full review", {
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }

  if (decision.decision === "review") {
    logPhase(logger, "gate", "requested full review", { reason: decision.reason })
    return null
  }

  logPhase(logger, "gate", "resolved without full review", { decision: decision.decision })
  return postGateAnswer(state, decision)
}

/**
 * Revalidates the queue, writes the validation artifact, and mirrors dropped
 * items back into the queue for audit/synthesis visibility.
 */
function validateCurrentQueue(
  state: ReviewWorkflowState,
  context: ReviewContext,
  phase: ReviewWorkflowPhase,
  message: string
): ValidatedReviewQueue {
  const validated = validateQueue(loadQueue(state.paths.queueFile), context)
  state.artifacts.writeJson(state.paths.validatedFile, validated)
  persistValidation(state.paths.queueFile, validated)
  logPhase(state.logger, phase, message, validated.stats)
  return validated
}

/**
 * Lets OpenCode tighten the queue after deterministic validation has identified
 * invalid, duplicate, or already-covered comments.
 */
async function runAuditPhase(
  state: ReviewWorkflowState,
  context: ReviewContext,
  currentValidation: ValidatedReviewQueue,
  reviewAttempt: ReviewAttempt
): Promise<ValidatedReviewQueue> {
  const { config, opencode, paths, opencodePaths, logger } = state

  if (!queueHasReviewActions(paths.queueFile)) {
    // Nothing actionable was queued, so there is no queue file work for audit.
    logPhase(logger, "audit", "review queue is empty; skipping")
    return currentValidation
  }

  const queueBeforeAudit = loadQueue(paths.queueFile)
  logPhase(logger, "audit", "running OpenCode")
  await opencode.run({
    workspace: config.workspace,
    outputFile: paths.auditOutputFile,
    jsonOutputFile: `${paths.auditOutputFile}.jsonl`,
    capabilitiesFile: paths.opencodeCapabilitiesFile,
    sessionFile: paths.auditorSessionFile,
    agent: "auditor",
    model: reviewAttempt.model,
    variant: reviewAttempt.variant ?? undefined,
    files: [
      opencodePaths.queuePath,
      opencodePaths.validatedPath,
      opencodePaths.auditorContextPath,
      opencodePaths.reviewOutputPath
    ],
    prompt: buildAuditPrompt({
      workspace: config.workspace,
      queueFile: opencodePaths.queuePath,
      validatedFile: opencodePaths.validatedPath,
      auditorContextFile: opencodePaths.auditorContextPath,
      reviewerOutputFile: opencodePaths.reviewOutputPath
    })
  })

  try {
    return validateCurrentQueue(state, context, "audit", "post-audit validation")
  } catch (error) {
    logger.warn("audit: post-audit queue validation failed; restoring pre-audit queue", {
      error: error instanceof Error ? error.message : String(error)
    })
    saveQueue(paths.queueFile, queueBeforeAudit)
    state.artifacts.writeJson(paths.validatedFile, currentValidation)
    return currentValidation
  }
}

/**
 * Produces the top-level GitHub review body. The model writes body content only;
 * bannering, truncation, and final validation stay mechanical in the runner.
 */
async function runSynthesisPhase(
  state: ReviewWorkflowState,
  context: ReviewContext,
  reviewPass: OpenCodeRunResult,
  reviewAttempt: ReviewAttempt
): Promise<string> {
  const { config, opencode, artifacts, paths, opencodePaths, logger } = state
  const reviewerOutputText = existsSync(paths.reviewOutputFile)
    ? readFileSync(paths.reviewOutputFile, "utf8")
    : reviewPass.text
  const reviewSeemsComplete = reviewerOutputSeemsComplete(reviewerOutputText)
  artifacts.writeJson(paths.auditorContextFile, {
    ...buildAuditorContext(context),
    review_seems_complete: reviewSeemsComplete
  })
  if (!reviewSeemsComplete) {
    logger.warn("synthesis: reviewer output does not include terminal review language")
  }

  logPhase(logger, "synthesis", "running OpenCode")
  const prompt = buildSynthesisPrompt({
    reviewerOutputFile: opencodePaths.reviewOutputPath,
    validatedFile: opencodePaths.validatedPath,
    auditorContextFile: opencodePaths.auditorContextPath
  })
  const synthesisInput = {
    workspace: config.workspace,
    outputFile: paths.synthesisOutputFile,
    jsonOutputFile: `${paths.synthesisOutputFile}.jsonl`,
    capabilitiesFile: paths.opencodeCapabilitiesFile,
    sessionFile: paths.auditorSessionFile,
    agent: "auditor" as const,
    model: reviewAttempt.model,
    variant: reviewAttempt.variant ?? undefined,
    files: [opencodePaths.reviewOutputPath, opencodePaths.validatedPath, opencodePaths.auditorContextPath]
  }

  let synthesis = await opencode.run({
    ...synthesisInput,
    reuseSession: true,
    prompt
  })
  if (!synthesis.text.trim()) {
    logger.warn("synthesis: empty body; retrying in a fresh session")
    synthesis = await opencode.run({
      ...synthesisInput,
      reuseSession: false,
      prompt: `${prompt}\n\nThe previous synthesis attempt produced no review body. Write the required final body now; do not return an empty response.`
    })
  }

  return synthesis.text.trim() || fallbackConclusion(loadQueue(paths.queueFile).inlineComments.length > 0)
}

/**
 * Applies the final mechanical transformations and performs all GitHub writes.
 * Dry-run mode uses the same payload construction but swaps the GitHub client.
 */
async function submitReviewResult(
  state: ReviewWorkflowState,
  context: ReviewContext,
  synthesized: string,
  model: string
): Promise<ReviewWorkflowResult> {
  const { config, github, artifacts, paths, logger } = state

  const finalBody = enforceReviewBodyLimit(applyReviewBanner(synthesized, model))
  setConclusion(paths.queueFile, finalBody)

  // Revalidate after setting the conclusion so the submitted payload is built
  // from exactly the queue state persisted to runtime artifacts.
  const validated = validateCurrentQueue(state, context, "synthesis", "final review validation")
  const payload = buildReviewPayload(validated)
  artifacts.writeJson(paths.payloadFile, payload)

  if (validated.inlineComments.length > 0 || validated.conclusion) {
    await github.submitReview(config.prNumber, payload)
    logger.info(config.dryRun ? "prepared dry-run review" : "submitted review", {
      inlineComments: validated.inlineComments.length
    })
  }

  for (const reply of validated.replies) {
    await github.submitReply(config.prNumber, reply.to, reply.body)
  }
  if (validated.replies.length > 0) {
    logger.info(config.dryRun ? "prepared dry-run replies" : "submitted review replies", {
      replies: validated.replies.length
    })
  }

  return {
    status: config.dryRun ? "dry-run" : "submitted",
    inlineComments: validated.inlineComments.length,
    replies: validated.replies.length,
    payloadFile: paths.payloadFile,
    validatedFile: paths.validatedFile
  }
}

/**
 * Runs the full review pipeline: gathering, review, audit, synthesis, and
 * submission. Expected non-submission outcomes are returned explicitly.
 */
export async function runReviewWorkflow(deps: ReviewWorkflowDependencies): Promise<ReviewWorkflowResult> {
  const state = createReviewWorkflowState(deps)
  const { config, paths, logger } = state

  clearStaleRunState(paths)
  exposeReviewArtifactsToTools(config, paths)

  const context = await runGatheringPhase(state)
  const diffText = readFileSync(paths.diffFile, "utf8")
  if (config.dryRun) {
    logPhase(logger, "gate", "skipped for dry run; running full review")
  } else {
    const gateResult = await runGatePhase(state, context, diffText)
    if (gateResult) {
      return gateResult
    }
  }

  if (!diffText.trim()) {
    // Empty diffs are valid PR states, but there is nothing safe to attach
    // line-level feedback to.
    logPhase(logger, "gathering", "PR diff is empty; skipping review")
    return { status: "skipped", reason: "PR diff is empty" }
  }

  const { reviewPass, validation: reviewValidation, attempt } = await runReviewAttempts(state, context)

  await runAuditPhase(state, context, reviewValidation, attempt)
  return submitReviewResult(state, context, await runSynthesisPhase(state, context, reviewPass, attempt), attempt.model)
}

export const runReview = runReviewWorkflow
