#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[singular-code-review] %s\n' "$*" >&2
}

output() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  fi
}

allow() {
  output should_review true
  output reason allowed
  log "review guard allowed request"
  exit 0
}

deny() {
  local reason="$1"
  output should_review false
  output reason "$reason"
  log "review guard skipped request: $reason"
  exit 0
}

die() {
  log "review guard error: $*"
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required tool not found: $1"
}

json_value() {
  local file="$1"
  local expression="$2"

  node - "$file" "$expression" <<'NODE'
const fs = require("node:fs");

const [, , file, expression] = process.argv;
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const value = Function("data", `"use strict"; return (${expression});`)(data);
process.stdout.write(value === undefined || value === null ? "" : String(value));
NODE
}

require_tool gh
require_tool node

[[ -n "${GITHUB_REPOSITORY:-}" ]] || die "GITHUB_REPOSITORY is required"
[[ -n "${PR_NUMBER:-}" ]] || die "PR_NUMBER is required"

tmp_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
pr_file="$(mktemp "${tmp_dir%/}/singular-code-review-pr.XXXXXX.json")"
comment_file="$(mktemp "${tmp_dir%/}/singular-code-review-comment.XXXXXX.json")"

if ! gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}" > "$pr_file"; then
  deny "pull request not found"
fi

head_repo="$(json_value "$pr_file" 'data.head?.repo?.full_name || ""')"
if [[ "$head_repo" != "$GITHUB_REPOSITORY" ]]; then
  deny "fork pull requests are not reviewed"
fi

if [[ -n "${TRIGGER_COMMENT_ID:-}" ]]; then
  if ! gh api "repos/${GITHUB_REPOSITORY}/issues/comments/${TRIGGER_COMMENT_ID}" > "$comment_file"; then
    deny "trigger comment not found"
  fi

  comment_issue_url="$(json_value "$comment_file" 'data.issue_url || ""')"
  comment_association="$(json_value "$comment_file" 'data.author_association || ""')"
  comment_user_type="$(json_value "$comment_file" 'data.user?.type || ""')"
  comment_mentions_reviewer="$(
    json_value "$comment_file" 'String(data.body || "").includes("@singular-code-review") ? "true" : "false"'
  )"

  if [[ "$comment_issue_url" != *"/repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}" ]]; then
    deny "trigger comment does not belong to this pull request"
  fi

  case "$comment_association" in
    OWNER|MEMBER|COLLABORATOR) ;;
    *) deny "trigger comment author is not trusted" ;;
  esac

  if [[ "$comment_user_type" == "Bot" ]]; then
    deny "bot trigger comments are ignored"
  fi

  if [[ "$comment_mentions_reviewer" != "true" ]]; then
    deny "trigger comment does not mention @singular-code-review"
  fi
fi

allow
