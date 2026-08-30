import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JUDGE_RUBRIC } from "./judge-rubric.mjs";

export function buildJudgePrompt({ repoRoot, job }) {
  const instructions = readFileSync(resolve(repoRoot, "eval", "judge-prompt.md"), "utf8");
  return `${instructions}

Attached files:
- review_model_context.json: eval-owned pull request context
- pr.diff: reviewed diff after reviewer-side filtering
- review.md: candidate final review body plus exported inline/reply/dropped comments
- review_comments.json: canonical dry-run comment export
- review_stats.json: canonical phase, attempt, token, and cost telemetry
- review_transcript.md: canonical gate, specialist, audit, validation, and publication transcript
- historical captures may include additional implementation diagnostics

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
