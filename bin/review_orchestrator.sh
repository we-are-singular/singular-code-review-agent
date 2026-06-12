#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

log() {
  printf '[opencode-reviewer] %s\n' "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"
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

install_opencode_runtime_config() {
  local home_dir="${HOME:-/root}"
  local config_file="$home_dir/.config/opencode/opencode.json"
  local template_file="${OPENCODE_CONFIG_TEMPLATE:-/usr/local/share/opencode-reviewer/opencode.json}"

  mkdir -p \
    "$home_dir/.config/opencode" \
    "$home_dir/.local/share/opencode" \
    "$home_dir/.cache/opencode" \
    "$home_dir/.local/state/opencode"

  if [[ ! -f "$template_file" && -f "$REPO_ROOT/opencode/opencode.json" ]]; then
    template_file="$REPO_ROOT/opencode/opencode.json"
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
  local prompt

  require_tool opencode
  require_tool review_comments
  require_tool review_context

  prompt="Review this pull request using the normalized context at ${context_file} and diff at ${diff_file}. Start by running review_context if you need the context JSON. Use read-only git, gh, rg, tests, and Context7 MCP as needed for investigation. Queue new findings with review_comments add, queue multiline findings with review_comments add --start-line, queue code suggestions with review_comments suggest, and queue replies to existing review discussions with review_comments reply. Never use gh api to post review comments or reviews directly. Do not edit repository files."

  log "running OpenCode review"
  if opencode run --help >/tmp/opencode-run-help.txt 2>&1; then
    (cd "$workspace" && opencode run --agent "${OPENCODE_AGENT:-coder}" --file "$context_file" --file "$diff_file" "$prompt")
  else
    (cd "$workspace" && opencode -q -c "$workspace" -p "$prompt")
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

build_review_payload() {
  local validated_file="$1"
  local output_file="$2"
  local review_body="${REVIEW_BODY:-OpenCode automated code review completed.}"

  node - "$validated_file" "$output_file" "$review_body" <<'NODE'
const fs = require("node:fs");

const [, , validatedFile, outputFile, reviewBody] = process.argv;
const validated = JSON.parse(fs.readFileSync(validatedFile, "utf8"));
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
  `${JSON.stringify({ body: reviewBody, event: "COMMENT", comments }, null, 2)}\n`
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

  local queue_file="${REVIEW_QUEUE_FILE:-/tmp/review_queue.json}"
  local context_file="${REVIEW_CONTEXT_FILE:-/tmp/review_context.json}"
  local diff_file="${REVIEW_DIFF_FILE:-/tmp/pr.diff}"
  local validated_file="${REVIEW_VALIDATED_FILE:-/tmp/review_validated.json}"
  local payload_file="${REVIEW_PAYLOAD_FILE:-/tmp/final_review.json}"
  local inline_count
  local reply_count

  export REVIEW_QUEUE_FILE="$queue_file"
  export REVIEW_CONTEXT_FILE="$context_file"
  export REVIEW_DIFF_FILE="$diff_file"
  export OPENCODE_MODEL="${OPENCODE_MODEL:-opencode-go/minimax-m2.7}"
  export OPENCODE_REVIEW_COMMAND="${OPENCODE_REVIEW_COMMAND:-@singular-code-review}"

  install_opencode_runtime_config
  build_review_context "$context_file" "$diff_file"
  review_comments clear --queue "$queue_file" >/dev/null
  install_dependencies "$workspace"
  run_opencode_review "$workspace" "$context_file" "$diff_file"

  review_comments validate --queue "$queue_file" --context "$context_file" --output "$validated_file" >/tmp/review_validate.stdout.json
  log "comment validation: $(cat /tmp/review_validate.stdout.json)"

  inline_count="$(json_count "$validated_file" "inlineComments")"
  reply_count="$(json_count "$validated_file" "replies")"

  if [[ "$inline_count" -eq 0 && "$reply_count" -eq 0 ]]; then
    log "no valid comments or replies queued; skipping GitHub submission"
    exit 0
  fi

  require_tool gh

  if [[ "$inline_count" -gt 0 ]]; then
    build_review_payload "$validated_file" "$payload_file"
    submit_inline_review "$payload_file"
    log "submitted ${inline_count} inline comment(s)"
  fi

  if [[ "$reply_count" -gt 0 ]]; then
    submit_replies "$validated_file"
    log "submitted ${reply_count} review reply/replies"
  fi
}

main "$@"
