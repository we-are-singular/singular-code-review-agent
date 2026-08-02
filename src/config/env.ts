import { type ArtifactPaths } from "../lib/artifacts.js"
import { REVIEW_BOT_LOGIN, REVIEW_COMMAND } from "../review/types.js"
import { buildArtifactPaths, resolveWorkspace } from "./paths.js"

export type RunnerConfig = {
  repository: string
  prNumber: number
  githubToken: string
  workspace: string
  dryRun: boolean
  model: string
  modelVariant: string | null
  gateModel: string
  gateModelVariant: string | null
  command: string
  botLogin: string
  ignoreHistory: boolean
  artifacts: ArtifactPaths
  triggerCommentId: number | null
  eventName: string | null
  eventPath: string | null
  actor: string | null
}

type ParsedArgs = {
  repo?: string
  pr?: string
  workspace?: string
  runtimeDir?: string
  dryRun?: boolean
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--dry-run") {
      result.dryRun = true
      continue
    }

    if (arg === "--repo") {
      result.repo = argv[++index]
      continue
    }

    if (arg === "--pr") {
      result.pr = argv[++index]
      continue
    }

    if (arg === "--workspace") {
      result.workspace = argv[++index]
      continue
    }

    if (arg === "--runtime-dir") {
      result.runtimeDir = argv[++index]
      continue
    }
  }

  return result
}

function requiredString(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

function parsePositiveInt(value: string | undefined, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function optionalPositiveInt(value: string | undefined): number | null {
  if (!value) {
    return null
  }
  return parsePositiveInt(value, "TRIGGER_COMMENT_ID")
}

/**
 * Splits an optional OpenCode model variant off a model id given as
 * `provider/model:variant`. OpenCode resolves variants only through its
 * separate `--variant` flag, so the runner must never pass the raw suffix
 * in the model id itself.
 */
export function parseModelSpec(value: string): { model: string; variant: string | null } {
  const index = value.indexOf(":")
  if (index === -1) {
    return { model: value, variant: null }
  }
  return { model: value.slice(0, index), variant: value.slice(index + 1) || null }
}

/**
 * Loads the runner configuration at the CLI boundary from GitHub Actions env
 * vars plus local dry-run overrides.
 */
export function loadRunnerConfig(env: NodeJS.ProcessEnv, argv: string[] = []): RunnerConfig {
  const args = parseCliArgs(argv)
  const workspace = args.workspace || resolveWorkspace(env)
  const artifacts = buildArtifactPaths(env, workspace, args.runtimeDir)
  const modelSpec = parseModelSpec(env.OPENCODE_MODEL || "opencode/deepseek-v4-flash-free")
  const gateModelSpec = parseModelSpec(env.OPENCODE_GATE_MODEL || "opencode-go/deepseek-v4-flash")

  return {
    repository: requiredString(args.repo || env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY"),
    prNumber: parsePositiveInt(args.pr || env.PR_NUMBER, "PR_NUMBER"),
    githubToken: requiredString(env.GH_TOKEN || env.GITHUB_TOKEN, "GH_TOKEN"),
    workspace,
    dryRun: args.dryRun || env.DRY_RUN === "true",
    model: modelSpec.model,
    modelVariant: modelSpec.variant,
    gateModel: gateModelSpec.model,
    gateModelVariant: gateModelSpec.variant,
    command: REVIEW_COMMAND,
    botLogin: env.BOT_LOGIN || REVIEW_BOT_LOGIN,
    ignoreHistory: env.REVIEW_IGNORE_HISTORY === "true",
    artifacts,
    triggerCommentId: optionalPositiveInt(env.TRIGGER_COMMENT_ID),
    eventName: env.GITHUB_EVENT_NAME || null,
    eventPath: env.GITHUB_EVENT_PATH || null,
    actor: env.GITHUB_ACTOR || null
  }
}
