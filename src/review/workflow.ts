import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { type GitHubClient } from "../clients/github.js";
import { type OpenCodeClient, type OpenCodeRunResult } from "../clients/opencode.js";
import { type RunnerConfig } from "../config/env.js";
import { type ArtifactPaths, type ArtifactStore } from "../lib/artifacts.js";
import { type Logger } from "../lib/logger.js";
import { buildAuditPrompt, buildReviewPrompt, buildSynthesisPrompt } from "../prompts/prompts.js";
import { applyReviewBanner, buildReviewPayload, enforceReviewBodyLimit } from "./body.js";
import { buildAuditorContext, buildReviewContext, buildReviewerContext } from "./context.js";
import { clearQueue, loadQueue, persistValidation, setConclusion, validateQueue } from "./queue.js";
import { type ReviewContext, type ValidatedReviewQueue } from "./types.js";

/**
 * Stable phase names for logs, tests, and future workflow documentation.
 * These names describe the product flow, not implementation details.
 */
export const REVIEW_WORKFLOW_PHASES = ["gathering", "review", "audit", "synthesis"] as const;

export type ReviewWorkflowPhase = (typeof REVIEW_WORKFLOW_PHASES)[number];

export type ReviewWorkflowDependencies = {
  config: RunnerConfig;
  artifacts: ArtifactStore;
  github: GitHubClient;
  opencode: OpenCodeClient;
  logger: Logger;
};

export type ReviewWorkflowResult =
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "dry-run" | "submitted";
      inlineComments: number;
      replies: number;
      payloadFile: string;
      validatedFile: string;
    };

type OpenCodeReviewPaths = {
  reviewContextPath: string;
  auditorContextPath: string;
  diffPath: string;
  queuePath: string;
  validatedPath: string;
  reviewOutputPath: string;
};

type ReviewWorkflowState = ReviewWorkflowDependencies & {
  paths: ArtifactPaths;
  opencodePaths: OpenCodeReviewPaths;
};

function queueHasReviewActions(queueFile: string): boolean {
  const queue = loadQueue(queueFile);
  return queue.inlineComments.length > 0 || queue.replies.length > 0;
}

function fallbackConclusion(reviewText: string): string {
  const trimmed = reviewText.trim();
  if (trimmed) {
    return `Automated review completed, but the synthesis pass did not produce a body. Posting the reviewer output so the run still leaves a GitHub review:\n\n${trimmed}`;
  }

  return "Automated review completed, but the synthesis pass did not produce a body.";
}

/**
 * Prefer workspace-relative attachment paths so OpenCode can display useful
 * file names, while still supporting runtime artifacts outside the checkout.
 */
function pathForOpenCode(workspace: string, file: string): string {
  const relativePath = relative(workspace, file);
  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }
  return file;
}

function buildOpenCodeReviewPaths(config: RunnerConfig, paths: ArtifactPaths): OpenCodeReviewPaths {
  return {
    reviewContextPath: pathForOpenCode(config.workspace, paths.reviewerContextFile),
    auditorContextPath: pathForOpenCode(config.workspace, paths.auditorContextFile),
    diffPath: pathForOpenCode(config.workspace, paths.diffFile),
    queuePath: pathForOpenCode(config.workspace, paths.queueFile),
    validatedPath: pathForOpenCode(config.workspace, paths.validatedFile),
    reviewOutputPath: pathForOpenCode(config.workspace, paths.reviewOutputFile),
  };
}

function createReviewWorkflowState(deps: ReviewWorkflowDependencies): ReviewWorkflowState {
  const paths = deps.artifacts.paths;
  return {
    ...deps,
    paths,
    opencodePaths: buildOpenCodeReviewPaths(deps.config, paths),
  };
}

/**
 * Exposes artifact paths to the agent-facing CLI tools invoked by OpenCode.
 * This is the process-level bridge between the runner and `review_comments`.
 */
function exposeReviewArtifactsToTools(config: RunnerConfig, paths: ArtifactPaths): void {
  process.env.REVIEW_QUEUE_FILE = paths.queueFile;
  process.env.REVIEW_CONTEXT_FILE = paths.contextFile;
  process.env.REVIEWER_CONTEXT_FILE = paths.reviewerContextFile;
  process.env.REVIEW_DIFF_FILE = paths.diffFile;
  process.env.OPENCODE_MODEL = config.model;
}

function logPhase(
  logger: Logger,
  phase: ReviewWorkflowPhase,
  message: string,
  context?: Record<string, unknown>,
): void {
  logger.info(`${phase}: ${message}`, context);
}

/**
 * Gathers every durable input the later phases need: PR metadata, diff ranges,
 * existing comments/threads, trigger context, and bot history.
 */
async function runGatheringPhase(state: ReviewWorkflowState): Promise<ReviewContext> {
  const { config, github, artifacts, paths, logger } = state;

  logPhase(logger, "gathering", "building review context", {
    repository: config.repository,
    pr: config.prNumber,
  });

  const context = await buildReviewContext({
    github,
    repository: config.repository,
    prNumber: config.prNumber,
    diffFile: paths.diffFile,
    eventName: config.eventName,
    eventPath: config.eventPath,
    actor: config.actor,
    botLogin: config.botLogin,
  });

  artifacts.writeJson(paths.contextFile, context);
  artifacts.writeJson(paths.reviewerContextFile, buildReviewerContext(context));
  artifacts.writeJson(paths.auditorContextFile, buildAuditorContext(context));
  return context;
}

/**
 * Runs the only exploratory OpenCode phase. This phase may inspect the
 * repository and queue structured findings through the review tools.
 */
async function runReviewPhase(state: ReviewWorkflowState): Promise<OpenCodeRunResult> {
  const { config, opencode, paths, opencodePaths, logger } = state;

  clearQueue(paths.queueFile);
  logPhase(logger, "review", "running OpenCode");

  return opencode.run({
    workspace: config.workspace,
    outputFile: paths.reviewOutputFile,
    jsonOutputFile: `${paths.reviewOutputFile}.jsonl`,
    capabilitiesFile: paths.opencodeCapabilitiesFile,
    sessionFile: paths.reviewSessionFile,
    agent: "reviewer",
    files: [opencodePaths.reviewContextPath, opencodePaths.diffPath],
    prompt: buildReviewPrompt({
      contextFile: opencodePaths.reviewContextPath,
      diffFile: opencodePaths.diffPath,
    }),
  });
}

/**
 * Revalidates the queue, writes the validation artifact, and mirrors dropped
 * items back into the queue for audit/synthesis visibility.
 */
function validateCurrentQueue(
  state: ReviewWorkflowState,
  context: ReviewContext,
  phase: ReviewWorkflowPhase,
  message: string,
): ValidatedReviewQueue {
  const validated = validateQueue(loadQueue(state.paths.queueFile), context);
  state.artifacts.writeJson(state.paths.validatedFile, validated);
  persistValidation(state.paths.queueFile, validated);
  logPhase(state.logger, phase, message, validated.stats);
  return validated;
}

/**
 * Lets OpenCode tighten the queue after deterministic validation has identified
 * invalid, duplicate, or already-covered comments.
 */
async function runAuditPhase(
  state: ReviewWorkflowState,
  context: ReviewContext,
  currentValidation: ValidatedReviewQueue,
): Promise<ValidatedReviewQueue> {
  const { config, opencode, paths, opencodePaths, logger } = state;

  if (!queueHasReviewActions(paths.queueFile)) {
    // Nothing actionable was queued, so there is no queue file work for audit.
    logPhase(logger, "audit", "review queue is empty; skipping");
    return currentValidation;
  }

  logPhase(logger, "audit", "running OpenCode");
  await opencode.run({
    workspace: config.workspace,
    outputFile: paths.auditOutputFile,
    jsonOutputFile: `${paths.auditOutputFile}.jsonl`,
    capabilitiesFile: paths.opencodeCapabilitiesFile,
    sessionFile: paths.auditorSessionFile,
    agent: "auditor",
    files: [
      opencodePaths.queuePath,
      opencodePaths.validatedPath,
      opencodePaths.auditorContextPath,
      opencodePaths.reviewOutputPath,
    ],
    prompt: buildAuditPrompt({
      workspace: config.workspace,
      queueFile: opencodePaths.queuePath,
      validatedFile: opencodePaths.validatedPath,
      auditorContextFile: opencodePaths.auditorContextPath,
      reviewerOutputFile: opencodePaths.reviewOutputPath,
    }),
  });

  return validateCurrentQueue(state, context, "audit", "post-audit validation");
}

/**
 * Produces the top-level GitHub review body. The model writes body content only;
 * bannering, truncation, and final validation stay mechanical in the runner.
 */
async function runSynthesisPhase(state: ReviewWorkflowState, reviewPass: OpenCodeRunResult): Promise<string> {
  const { config, opencode, paths, opencodePaths, logger } = state;

  logPhase(logger, "synthesis", "running OpenCode");
  const synthesis = await opencode.run({
    workspace: config.workspace,
    outputFile: paths.synthesisOutputFile,
    jsonOutputFile: `${paths.synthesisOutputFile}.jsonl`,
    capabilitiesFile: paths.opencodeCapabilitiesFile,
    sessionFile: paths.auditorSessionFile,
    reuseSession: true,
    agent: "auditor",
    files: [opencodePaths.reviewOutputPath, opencodePaths.validatedPath, opencodePaths.auditorContextPath],
    prompt: buildSynthesisPrompt({
      reviewerOutputFile: opencodePaths.reviewOutputPath,
      validatedFile: opencodePaths.validatedPath,
      auditorContextFile: opencodePaths.auditorContextPath,
    }),
  });

  return synthesis.text.trim() || fallbackConclusion(reviewPass.text);
}

/**
 * Applies the final mechanical transformations and performs all GitHub writes.
 * Dry-run mode uses the same payload construction but swaps the GitHub client.
 */
async function submitReviewResult(
  state: ReviewWorkflowState,
  context: ReviewContext,
  synthesized: string,
): Promise<ReviewWorkflowResult> {
  const { config, github, artifacts, paths, logger } = state;

  const finalBody = enforceReviewBodyLimit(applyReviewBanner(synthesized, config.model));
  setConclusion(paths.queueFile, finalBody);

  // Revalidate after setting the conclusion so the submitted payload is built
  // from exactly the queue state persisted to runtime artifacts.
  const validated = validateCurrentQueue(state, context, "synthesis", "final review validation");
  const payload = buildReviewPayload(validated);
  artifacts.writeJson(paths.payloadFile, payload);

  if (validated.inlineComments.length > 0 || validated.conclusion) {
    await github.submitReview(config.prNumber, payload);
    logger.info(config.dryRun ? "prepared dry-run review" : "submitted review", {
      inlineComments: validated.inlineComments.length,
    });
  }

  for (const reply of validated.replies) {
    await github.submitReply(config.prNumber, reply.to, reply.body);
  }
  if (validated.replies.length > 0) {
    logger.info(config.dryRun ? "prepared dry-run replies" : "submitted review replies", {
      replies: validated.replies.length,
    });
  }

  return {
    status: config.dryRun ? "dry-run" : "submitted",
    inlineComments: validated.inlineComments.length,
    replies: validated.replies.length,
    payloadFile: paths.payloadFile,
    validatedFile: paths.validatedFile,
  };
}

/**
 * Runs the full review pipeline: gathering, review, audit, synthesis, and
 * submission. Expected non-submission outcomes are returned explicitly.
 */
export async function runReviewWorkflow(deps: ReviewWorkflowDependencies): Promise<ReviewWorkflowResult> {
  const state = createReviewWorkflowState(deps);
  const { config, paths, logger } = state;

  exposeReviewArtifactsToTools(config, paths);

  const context = await runGatheringPhase(state);
  if (!readFileSync(paths.diffFile, "utf8").trim()) {
    // Empty diffs are valid PR states, but there is nothing safe to attach
    // line-level feedback to.
    logPhase(logger, "gathering", "PR diff is empty; skipping review");
    return { status: "skipped", reason: "PR diff is empty" };
  }

  const reviewPass = await runReviewPhase(state);
  const reviewValidation = validateCurrentQueue(state, context, "review", "finding validation");
  await runAuditPhase(state, context, reviewValidation);
  const synthesized = await runSynthesisPhase(state, reviewPass);

  return submitReviewResult(state, context, synthesized);
}

export const runReview = runReviewWorkflow;
