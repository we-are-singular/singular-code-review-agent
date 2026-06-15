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

resolve_workspace() {
  if [[ -n "${WORKSPACE:-}" ]]; then
    printf '%s\n' "$WORKSPACE"
  elif [[ -n "${GITHUB_WORKSPACE:-}" ]]; then
    printf '%s\n' "$GITHUB_WORKSPACE"
  elif [[ -d /github/workspace ]]; then
    printf '%s\n' "/github/workspace"
  else
    pwd
  fi
}

install_opencode_runtime_config() {
  local home_dir="${HOME:-/root}"
  local config_home="${XDG_CONFIG_HOME:-$home_dir/.config}"
  local data_home="${XDG_DATA_HOME:-$home_dir/.local/share}"
  local cache_home="${XDG_CACHE_HOME:-$home_dir/.cache}"
  local state_home="${XDG_STATE_HOME:-$home_dir/.local/state}"
  local config_dir="$config_home/opencode"
  local config_file="$config_dir/opencode.json"
  local agents_dir="$config_dir/agents"
  local skills_dir="$config_dir/skills"
  local template_file="/usr/local/share/singular-code-review/opencode.json"
  local template_agents_dir="/usr/local/share/singular-code-review/agents"
  local template_skills_dir="/usr/local/share/singular-code-review/skills"

  mkdir -p \
    "$config_dir" \
    "$agents_dir" \
    "$skills_dir" \
    "$data_home/opencode" \
    "$cache_home/opencode" \
    "$state_home/opencode"

  if [[ ! -f "$template_file" && -f "$REPO_ROOT/opencode/opencode.json" ]]; then
    template_file="$REPO_ROOT/opencode/opencode.json"
  fi

  if [[ ! -d "$template_agents_dir" && -d "$REPO_ROOT/opencode/agents" ]]; then
    template_agents_dir="$REPO_ROOT/opencode/agents"
  fi

  if [[ ! -d "$template_skills_dir" && -d "$REPO_ROOT/opencode/skills" ]]; then
    template_skills_dir="$REPO_ROOT/opencode/skills"
  fi

  if [[ -f "$template_file" ]]; then
    cp "$template_file" "$config_file"
    log "installed OpenCode config template"
  elif [[ ! -f "$config_file" ]]; then
    printf '{}\n' > "$config_file"
    log "no OpenCode config template found; wrote empty config"
  fi

  if [[ -d "$template_agents_dir" ]]; then
    cp -R "$template_agents_dir"/. "$agents_dir"/
    log "installed OpenCode agents"
  fi

  if [[ -d "$template_skills_dir" ]]; then
    cp -R "$template_skills_dir"/. "$skills_dir"/
    log "installed OpenCode skills"
  fi
}

install_dependencies() {
  local workspace="$1"
  local install_deps="${SINGULAR_CODE_REVIEW_INSTALL_DEPS:-false}"

  case "${install_deps,,}" in
    true|1|yes|on)
      ;;
    *)
      log "dependency install disabled; skipping package manager install"
      return
      ;;
  esac

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
    (cd "$workspace" && npm ci --dangerously-allow-all-scripts)
  else
    log "installing dependencies with npm install --no-package-lock"
    (cd "$workspace" && npm install --no-package-lock --dangerously-allow-all-scripts)
  fi
}

main() {
  require_tool git
  require_tool node

  local workspace
  workspace="$(resolve_workspace)"
  [[ -d "$workspace" ]] || die "workspace does not exist: $workspace"

  log "provisioning workspace: $workspace"
  mkdir -p "${HOME:-/root}"
  git config --global --add safe.directory "$workspace" || true
  install_opencode_runtime_config
  install_dependencies "$workspace"
}

main "$@"
