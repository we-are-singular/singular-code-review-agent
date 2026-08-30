import { join } from "node:path";
import { sha256File, sha256Json, sha256Text } from "./cache.mjs";
import { buildJudgePrompt } from "./judge-prompt.mjs";
import { slugify } from "./pr-input.mjs";

export const JUDGE_CACHE_VERSION = 3;

export function judgeCacheKey({ repoRoot, model, jobDir, job }) {
  return sha256Json({
    version: JUDGE_CACHE_VERSION,
    model,
    jobKey: `${job.input.slug}__${slugify(job.model)}`,
    candidateModel: job.model,
    promptHash: sha256Text(buildJudgePrompt({ repoRoot, job })),
    contextHash: sha256File(join(jobDir, "artifacts", "review_model_context.json")),
    diffHash: sha256File(join(jobDir, "artifacts", "pr.diff")),
    queueHash: sha256File(join(jobDir, "artifacts", "review_queue.json")),
    payloadHash: sha256File(join(jobDir, "artifacts", "review_payload.json")),
    validatedHash: sha256File(join(jobDir, "artifacts", "review_validated.json")),
    validationContextHash: sha256File(join(jobDir, "artifacts", "review_validation_context.json")),
    auditContextHash: sha256File(join(jobDir, "artifacts", "audit_model_context.json")),
    reviewOutputHash: sha256File(join(jobDir, "artifacts", "opencode_review.log")),
    reviewJsonOutputHash: sha256File(join(jobDir, "artifacts", "opencode_review.log.jsonl")),
    auditOutputHash: sha256File(join(jobDir, "artifacts", "opencode_audit.log")),
    auditJsonOutputHash: sha256File(join(jobDir, "artifacts", "opencode_audit.log.jsonl")),
    synthesisOutputHash: sha256File(join(jobDir, "artifacts", "opencode_synthesis.log")),
    synthesisJsonOutputHash: sha256File(join(jobDir, "artifacts", "opencode_synthesis.log.jsonl")),
    reviewHash: sha256File(join(jobDir, "review.md")),
    commentsHash: sha256File(join(jobDir, "review_comments.json")),
    statsHash: sha256File(join(jobDir, "review_stats.json")),
    transcriptHash: sha256File(join(jobDir, "review_transcript.md")),
  });
}
