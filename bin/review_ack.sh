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

continue_review() {
  output should_review true
  log "$1"
  exit 0
}

skip_review() {
  output should_review false
  log "$1"
  exit 0
}

die() {
  log "review ack error: $*"
  exit 1
}

command -v gh >/dev/null 2>&1 || die "required tool not found: gh"

[[ -n "${GITHUB_REPOSITORY:-}" ]] || die "GITHUB_REPOSITORY is required"
[[ -n "${BOT_LOGIN:-}" ]] || die "BOT_LOGIN is required"

if [[ -z "${COMMENT_ID:-}" ]]; then
  continue_review "direct pull request trigger; continuing review"
fi

existing="$(
  gh api \
    -H "Accept: application/vnd.github+json" \
    "repos/${GITHUB_REPOSITORY}/issues/comments/${COMMENT_ID}/reactions" \
    --jq '.[] | select(.content == "eyes" and .user.login == env.BOT_LOGIN) | .id'
)"

if [[ -n "$existing" ]]; then
  skip_review "trigger comment already acknowledged by ${BOT_LOGIN}; skipping review"
fi

gh api \
  -X POST \
  -H "Accept: application/vnd.github+json" \
  "repos/${GITHUB_REPOSITORY}/issues/comments/${COMMENT_ID}/reactions" \
  -f content='eyes' \
  --silent

continue_review "trigger comment acknowledged by ${BOT_LOGIN}; continuing review"
