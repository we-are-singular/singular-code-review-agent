#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

log() {
  printf '[singular-code-review] %s\n' "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"
}

ensure_parent_dir() {
  local file="$1"
  local dir="${file%/*}"
  if [[ "$dir" != "$file" ]]; then
    mkdir -p "$dir"
  fi
}

resolve_workspace() {
  if [[ -n "${WORKSPACE:-}" ]]; then
    printf '%s\n' "$WORKSPACE"
  elif [[ -d /github/workspace ]]; then
    printf '%s\n' "/github/workspace"
  else
    pwd
  fi
}

resolve_runtime_dir() {
  local workspace="$1"

  if [[ -d "$workspace/.git" ]]; then
    printf '%s\n' "$workspace/.git/singular-code-review"
  else
    printf '%s\n' "/tmp/opencode/singular-code-review"
  fi
}

install_opencode_runtime_config() {
  local home_dir="${HOME:-/root}"
  local config_file="$home_dir/.config/opencode/opencode.json"
  local prompt_file="$home_dir/.config/opencode/AGENTS.md"
  local template_file="/usr/local/share/singular-code-review/opencode.json"
  local template_prompt_file="/usr/local/share/singular-code-review/AGENTS.md"

  mkdir -p \
    "$home_dir/.config/opencode" \
    "$home_dir/.local/share/opencode" \
    "$home_dir/.cache/opencode" \
    "$home_dir/.local/state/opencode"

  if [[ ! -f "$template_file" && -f "$REPO_ROOT/opencode/opencode.json" ]]; then
    template_file="$REPO_ROOT/opencode/opencode.json"
  fi
  if [[ ! -f "$template_prompt_file" && -f "$REPO_ROOT/opencode/AGENTS.md" ]]; then
    template_prompt_file="$REPO_ROOT/opencode/AGENTS.md"
  fi

  if [[ -f "$template_file" ]]; then
    if [[ "$template_file" != "$config_file" ]]; then
      cp "$template_file" "$config_file"
    fi
    log "installed OpenCode config template"
  elif [[ -f "$config_file" ]]; then
    log "using existing OpenCode config"
  else
    printf '{}\n' > "$config_file"
    log "no OpenCode config template found; wrote empty config"
  fi

  if [[ -f "$template_prompt_file" && "$template_prompt_file" != "$prompt_file" ]]; then
    cp "$template_prompt_file" "$prompt_file"
    log "installed OpenCode prompt template"
  fi
}

install_dependencies() {
  local workspace="$1"

  if [[ ! -f "$workspace/package.json" ]]; then
    log "no package.json found; skipping dependency install"
    return
  fi

  if [[ -f "$workspace/pnpm-lock.yaml" ]]; then
    require_tool corepack
    log "installing dependencies with pnpm"
    (cd "$workspace" && corepack enable && pnpm install --frozen-lockfile)
    return
  fi

  if [[ -f "$workspace/yarn.lock" ]]; then
    require_tool corepack
    log "installing dependencies with yarn"
    (cd "$workspace" && corepack enable && yarn install --immutable || yarn install --frozen-lockfile)
    return
  fi

  require_tool npm
  if [[ -f "$workspace/package-lock.json" || -f "$workspace/npm-shrinkwrap.json" ]]; then
    log "installing dependencies with npm ci"
    (cd "$workspace" && npm ci)
  else
    log "installing dependencies with npm install --no-package-lock"
    (cd "$workspace" && npm install --no-package-lock)
  fi
}

build_review_context() {
  local context_file="$1"
  local diff_file="$2"

  require_tool review_context
  require_tool gh

  review_context --refresh --output "$context_file" --diff-file "$diff_file" >/tmp/review_context.stdout.json
  if [[ ! -s "$diff_file" ]]; then
    log "PR diff is empty; nothing to review"
    exit 0
  fi
}

run_opencode_review() {
  local workspace="$1"
  local context_file="$2"
  local diff_file="$3"
  local output_file="$4"
  local prompt

  require_tool opencode
  require_tool review_comments
  require_tool review_context

  prompt="Review this pull request using the normalized context at ${context_file} and diff at ${diff_file}. Start by running review_context if you need the context JSON. Use read-only git, gh, rg, tests, and Context7 MCP as needed for investigation. If a top-level @singular-code-review trigger comment asks a direct question or gives instructions, answer it at the top of your terminal output addressed to the commenter, then continue with the review. Check unresolved_bot_threads and previous_bot_findings before adding inline comments so you do not duplicate active bot findings. Queue new findings with review_comments add, queue multiline findings with review_comments add --start-line, queue code suggestions with review_comments suggest, and queue replies to existing review discussions with review_comments reply. If multiple comments are queued for the same path and line, make the last one the best combined wording; the runner drops older same-location queued comments. Always pass review text with --body-stdin, --body-file, --message-stdin, or --message-file; prefer a single-quoted heredoc such as <<'REVIEW_COMMENT'. Never put Markdown, backticks, quotes, or code snippets directly in shell arguments. Do not queue a final conclusion; a second synthesis pass will turn your review output into the GitHub review body. Never use gh api to post review comments or reviews directly. Do not edit repository files."

  log "running OpenCode review"
  if opencode run --help >/tmp/opencode-run-help.txt 2>&1; then
    (cd "$workspace" && opencode run --agent reviewer --file "$context_file" --file "$diff_file" -- "$prompt") 2>&1 | tee "$output_file"
  else
    (cd "$workspace" && opencode -q -c "$workspace" -p "$prompt") 2>&1 | tee "$output_file"
  fi
}

json_count() {
  local file="$1"
  local expr="$2"

  node - "$file" "$expr" <<'NODE'
const fs = require("node:fs");

const [, , file, expr] = process.argv;
const value = JSON.parse(fs.readFileSync(file, "utf8"));
const selected = expr.split(".").reduce((current, key) => current?.[key], value);
process.stdout.write(`${Array.isArray(selected) ? selected.length : 0}\n`);
NODE
}

json_has_text() {
  local file="$1"
  local expr="$2"

  node - "$file" "$expr" <<'NODE'
const fs = require("node:fs");

const [, , file, expr] = process.argv;
const value = JSON.parse(fs.readFileSync(file, "utf8"));
const selected = expr.split(".").reduce((current, key) => current?.[key], value);
process.stdout.write(`${typeof selected === "string" && selected.trim() ? 1 : 0}\n`);
NODE
}

sanitize_conclusion_text() {
  local input_file="$1"

  node - "$input_file" <<'NODE'
const fs = require("node:fs");

const [, , inputFile] = process.argv;
let output = "";
try {
  output = fs.readFileSync(inputFile, "utf8");
} catch {
  output = "";
}

const cleanedLines = [];
for (const line of output
  .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
  .split(/\r?\n/)
  .map((value) => value.trimEnd())) {
  const trimmed = line.trim();
  if (
    /^Performing one time database migration/.test(trimmed) ||
    trimmed === "sqlite-migration:done" ||
    trimmed === "Database migration complete."
  ) {
    continue;
  }

  if (!trimmed) {
    if (cleanedLines.length && cleanedLines[cleanedLines.length - 1] !== "") {
      cleanedLines.push("");
    }
    continue;
  }

  cleanedLines.push(line);
}

while (cleanedLines[0] === "") {
  cleanedLines.shift();
}
while (cleanedLines[cleanedLines.length - 1] === "") {
  cleanedLines.pop();
}

for (let index = 0; index < cleanedLines.length - 1; index += 1) {
  if (/^>\s+\S+\s+·\s+.+$/.test(cleanedLines[index].trim()) && cleanedLines[index + 1] !== "") {
    cleanedLines.splice(index + 1, 0, "");
  }
}

output = cleanedLines.join("\n").trim();

const maxOutputLength = 6000;
if (output.length > maxOutputLength) {
  output = `${output.slice(0, maxOutputLength).trimEnd()}\n\n[Conclusion truncated]`;
}

process.stdout.write(output);
NODE
}

build_static_fallback_conclusion() {
  local output_file="$1"
  local reviewer_output

  reviewer_output="$(sanitize_conclusion_text "$output_file")"
  if [[ -n "$reviewer_output" ]]; then
    printf 'Automated review completed, but the reviewer did not queue structured comments or a conclusion. Posting the reviewer output so the run still leaves a GitHub review:\n\n%s' "$reviewer_output"
  else
    printf 'Automated review completed, but the reviewer did not queue structured comments or a conclusion.'
  fi
}

run_opencode_conclusion_synthesis() {
  local workspace="$1"
  local reviewer_output_file="$2"
  local conclusion_output_file="$3"
  local prompt
  local reviewer_output
  local reviewer_output_sanitized_file

  require_tool opencode

  reviewer_output="$(sanitize_conclusion_text "$reviewer_output_file")"
  reviewer_output_sanitized_file="${reviewer_output_file}.sanitized"
  printf '%s\n' "$reviewer_output" > "$reviewer_output_sanitized_file"
  prompt="The previous OpenCode reviewer produced terminal output for a pull request but did not queue a final GitHub review conclusion. Synthesize a concise, polished GitHub pull request review body from that output. Preserve a leading reviewer/model banner if present, and keep a blank line after it. Preserve any direct answer to a top-level @singular-code-review trigger comment near the top of the body, addressed to the commenter by GitHub handle when present, then add a blank line before the review summary and verdict. Use normal Markdown paragraphs separated by blank lines. Do not include command transcripts, queued-comment JSON, or tool status lines. Do not convert direct answers into buried notes or indirect summaries such as 'a user asked'. Preserve only substantive findings, recommendations, and the overall verdict. Do not promote style nits, readability-only observations, or unqueued side notes into review issues. Do not invent issues that are not present. Do not call review_comments, gh, or any other posting tool. Write only the final review body text to stdout."

  log "running OpenCode conclusion synthesis"
  if opencode run --help >/tmp/opencode-run-help.txt 2>&1; then
    (cd "$workspace" && opencode run --agent reviewer --file "$reviewer_output_sanitized_file" -- "$prompt") 2>&1 | tee "$conclusion_output_file"
  else
    (cd "$workspace" && opencode -q -c "$workspace" -p "${prompt}

Reviewer terminal output:
${reviewer_output}") 2>&1 | tee "$conclusion_output_file"
  fi
}

build_review_payload() {
  local validated_file="$1"
  local output_file="$2"

  node - "$validated_file" "$output_file" <<'NODE'
const fs = require("node:fs");

const [, , validatedFile, outputFile] = process.argv;
const validated = JSON.parse(fs.readFileSync(validatedFile, "utf8"));
const body = String(validated.conclusion || "OpenCode automated code review completed.").trim();
const comments = validated.inlineComments.map((comment) => {
  const payload = {
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: comment.body
  };
  if (comment.start_line !== undefined) {
    payload.start_line = comment.start_line;
    payload.start_side = comment.start_side;
  }
  return payload;
});

fs.writeFileSync(
  outputFile,
  `${JSON.stringify({ body, event: "COMMENT", comments }, null, 2)}\n`
);
NODE
}

submit_inline_review() {
  local payload_file="$1"

  if [[ "${DRY_RUN:-false}" == "true" ]]; then
    log "DRY_RUN=true; not submitting inline review"
    cat "$payload_file"
    return
  fi

  gh api \
    -X POST \
    "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/reviews" \
    --input "$payload_file" \
    --silent
}

submit_replies() {
  local validated_file="$1"
  local reply_dir="/tmp/review_replies.${RANDOM}.$$"

  mkdir -p "$reply_dir"

  node - "$validated_file" "$reply_dir" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [, , validatedFile, replyDir] = process.argv;
const validated = JSON.parse(fs.readFileSync(validatedFile, "utf8"));

for (const reply of validated.replies) {
  fs.writeFileSync(
    path.join(replyDir, `${reply.to}.json`),
    `${JSON.stringify({ body: reply.body }, null, 2)}\n`
  );
}
NODE

  shopt -s nullglob
  for payload in "$reply_dir"/*.json; do
    local comment_id
    comment_id="$(basename "$payload" .json)"
    if [[ "${DRY_RUN:-false}" == "true" ]]; then
      log "DRY_RUN=true; not submitting reply to ${comment_id}"
      cat "$payload"
    else
      gh api \
        -X POST \
        "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/comments/${comment_id}/replies" \
        --input "$payload" \
        --silent
    fi
  done
  shopt -u nullglob
}

main() {
  require_tool node
  require_tool review_comments

  [[ -n "${PR_NUMBER:-}" ]] || die "PR_NUMBER is required"
  [[ -n "${GITHUB_REPOSITORY:-}" ]] || die "GITHUB_REPOSITORY is required"

  local workspace
  workspace="$(resolve_workspace)"
  [[ -d "$workspace" ]] || die "workspace does not exist: $workspace"

  local runtime_dir
  runtime_dir="$(resolve_runtime_dir "$workspace")"
  log "review workspace: $workspace"
  log "review runtime dir: $runtime_dir"
  local queue_file="${REVIEW_QUEUE_FILE:-${runtime_dir}/review_queue.json}"
  local context_file="${REVIEW_CONTEXT_FILE:-${runtime_dir}/review_context.json}"
  local diff_file="${REVIEW_DIFF_FILE:-${runtime_dir}/pr.diff}"
  local validated_file="${REVIEW_VALIDATED_FILE:-${runtime_dir}/review_validated.json}"
  local payload_file="${REVIEW_PAYLOAD_FILE:-${runtime_dir}/final_review.json}"
  local opencode_output_file="${OPENCODE_OUTPUT_FILE:-${runtime_dir}/opencode_review_output.log}"
  local opencode_conclusion_file="${OPENCODE_CONCLUSION_OUTPUT_FILE:-${runtime_dir}/opencode_review_conclusion.log}"
  local inline_count
  local reply_count
  local conclusion_count

  export REVIEW_QUEUE_FILE="$queue_file"
  export REVIEW_CONTEXT_FILE="$context_file"
  export REVIEW_DIFF_FILE="$diff_file"
  export OPENCODE_MODEL="${OPENCODE_MODEL:-opencode-go/minimax-m2.7}"

  ensure_parent_dir "$queue_file"
  ensure_parent_dir "$context_file"
  ensure_parent_dir "$diff_file"
  ensure_parent_dir "$validated_file"
  ensure_parent_dir "$payload_file"
  ensure_parent_dir "$opencode_output_file"
  ensure_parent_dir "$opencode_conclusion_file"

  install_opencode_runtime_config
  build_review_context "$context_file" "$diff_file"
  review_comments clear --queue "$queue_file" >/dev/null
  install_dependencies "$workspace"
  run_opencode_review "$workspace" "$context_file" "$diff_file" "$opencode_output_file"

  review_comments validate --queue "$queue_file" --context "$context_file" --output "$validated_file" >/tmp/review_validate.stdout.json
  log "finding validation: $(cat /tmp/review_validate.stdout.json)"

  log "synthesizing final review conclusion with OpenCode"
  run_opencode_conclusion_synthesis "$workspace" "$opencode_output_file" "$opencode_conclusion_file"
  local synthesized_conclusion
  synthesized_conclusion="$(sanitize_conclusion_text "$opencode_conclusion_file")"
  if [[ -z "$synthesized_conclusion" ]]; then
    log "OpenCode conclusion synthesis was empty; using reviewer output as fallback conclusion"
    synthesized_conclusion="$(build_static_fallback_conclusion "$opencode_output_file")"
  fi
  review_comments conclude --queue "$queue_file" --body "$synthesized_conclusion" >/dev/null

  review_comments validate --queue "$queue_file" --context "$context_file" --output "$validated_file" >/tmp/review_validate.stdout.json
  log "final review validation: $(cat /tmp/review_validate.stdout.json)"

  inline_count="$(json_count "$validated_file" "inlineComments")"
  reply_count="$(json_count "$validated_file" "replies")"
  conclusion_count="$(json_has_text "$validated_file" "conclusion")"

  require_tool gh

  if [[ "$inline_count" -gt 0 || "$conclusion_count" -gt 0 ]]; then
    build_review_payload "$validated_file" "$payload_file"
    submit_inline_review "$payload_file"
    log "submitted review with ${inline_count} inline comment(s)"
  fi

  if [[ "$reply_count" -gt 0 ]]; then
    submit_replies "$validated_file"
    log "submitted ${reply_count} review reply/replies"
  fi
}

main "$@"
