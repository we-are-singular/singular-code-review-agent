import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { type ArtifactPaths } from "../lib/artifacts.js";

/**
 * Resolves the repository workspace across local runs, GitHub Actions, and the
 * container default checkout path.
 */
export function resolveWorkspace(env: NodeJS.ProcessEnv): string {
  if (env.WORKSPACE) {
    return resolve(env.WORKSPACE);
  }

  if (env.GITHUB_WORKSPACE) {
    return resolve(env.GITHUB_WORKSPACE);
  }

  if (existsSync("/github/workspace")) {
    return "/github/workspace";
  }

  return process.cwd();
}

/**
 * Creates a stable per-workspace artifact root so repeated commands in one
 * checkout share context without colliding with other checkouts.
 */
export function defaultRuntimeDir(workspace: string): string {
  if (!workspace) {
    return join(tmpdir(), ".singular-code-review", "default");
  }

  const slug = basename(workspace).replace(/[^a-zA-Z0-9._-]+/gu, "-").slice(0, 64) || "workspace";
  const digest = createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 12);
  return join(tmpdir(), ".singular-code-review", `${slug}-${digest}`);
}

/**
 * Centralizes runtime artifact names used by the runner, review tools, and
 * dry-run diagnostics.
 */
export function buildArtifactPaths(env: NodeJS.ProcessEnv, workspace: string, runtimeDir?: string): ArtifactPaths {
  const resolvedRuntimeDir = runtimeDir || env.SINGULAR_CODE_REVIEW_RUNTIME_DIR || defaultRuntimeDir(workspace);

  return {
    runtimeDir: resolvedRuntimeDir,
    queueFile: env.REVIEW_QUEUE_FILE || join(resolvedRuntimeDir, "review_queue.json"),
    contextFile: env.REVIEW_CONTEXT_FILE || join(resolvedRuntimeDir, "review_context.json"),
    reviewerContextFile: env.REVIEWER_CONTEXT_FILE || join(resolvedRuntimeDir, "reviewer_context.json"),
    auditorContextFile: env.REVIEW_AUDITOR_CONTEXT_FILE || join(resolvedRuntimeDir, "review_auditor_context.json"),
    diffFile: env.REVIEW_DIFF_FILE || join(resolvedRuntimeDir, "pr.diff"),
    validatedFile: env.REVIEW_VALIDATED_FILE || join(resolvedRuntimeDir, "review_validated.json"),
    payloadFile: env.REVIEW_PAYLOAD_FILE || join(resolvedRuntimeDir, "review_payload.json"),
    transcriptFile: env.REVIEW_TRANSCRIPT_FILE || join(resolvedRuntimeDir, "review_transcript.md"),
    commentsFile: env.REVIEW_COMMENTS_FILE || join(resolvedRuntimeDir, "review_comments.json"),
    statsFile: env.REVIEW_STATS_FILE || join(resolvedRuntimeDir, "review_stats.json"),
    reviewOutputFile: env.OPENCODE_OUTPUT_FILE || join(resolvedRuntimeDir, "opencode_review.log"),
    auditOutputFile: env.OPENCODE_AUDIT_OUTPUT_FILE || join(resolvedRuntimeDir, "opencode_audit.log"),
    synthesisOutputFile: env.OPENCODE_SYNTHESIS_OUTPUT_FILE || join(resolvedRuntimeDir, "opencode_synthesis.log"),
    opencodeCapabilitiesFile: join(resolvedRuntimeDir, "opencode_capabilities.json"),
    reviewSessionFile: join(resolvedRuntimeDir, "opencode_review_session.txt"),
    auditorSessionFile: join(resolvedRuntimeDir, "opencode_auditor_session.txt"),
  };
}
