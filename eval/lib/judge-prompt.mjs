import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JUDGE_RUBRIC } from "./judge-rubric.mjs";

export function buildJudgePrompt({ repoRoot, job }) {
  const instructions = readFileSync(resolve(repoRoot, "eval", "judge-prompt.md"), "utf8");
  return `${instructions}

Attached files:
- review_model_context.json: production reviewer model context
- pr.diff: production reviewed diff, after reviewer-side filtering
- review_queue.json, review_payload.json, review_validated.json: queued, synthesized, and validated review artifacts
- review_validation_context.json, audit_model_context.json: production validation and audit contexts
- opencode_*.log and opencode_*.jsonl: rendered and raw phase output, including tool calls and results
- review.md: candidate final review body plus exported inline/reply/dropped comments
- review_comments.json: production dry-run comment export
- review_stats.json: production dry-run phase, token, and cost telemetry
- review_transcript.md: production dry-run transcript, including phase outputs

Rubric questions:

${JUDGE_RUBRIC.map((item, index) => `${index + 1}. ${item.id}: ${item.question}`).join("\n")}

Candidate:
${job.input.ref} with ${job.model}

Input settings:
${JSON.stringify(
  {
    ignoreHistory: Boolean(job.input.ignoreHistory),
    label: job.input.label || "",
    notes: job.input.notes || "",
  },
  null,
  2,
)}
`;
}
