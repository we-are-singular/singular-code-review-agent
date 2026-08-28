#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { evaluateGuard } from "../src/cli/review-guard.js"
import { readEventContext } from "../src/review/context.js"
import { REVIEW_BOT_LOGIN } from "../src/review/types.js"
import { parseAmlReviewProvider, type AmlReviewProvider } from "./providers.js"
import { runReview } from "./runtime.js"
import { createAmlGitHubClient } from "./services/github-client.js"

type CliOptions = {
  repository: string
  prNumber: number
  workspace: string
  provider: AmlReviewProvider
  model: string
  codexHome?: string
  concurrency: number
  publish: boolean
}

function usage(): string {
  return `usage: aml_review --repo <owner/repo> --pr <number> [options]

Runs the AML review in memory. GitHub mutations are recorded by default; pass
--publish explicitly to execute the exact validated publication plan.

Options:
  --workspace <path>          checked-out pull request workspace
  --provider <name>           AML Agent provider: opencode or codex (default: opencode)
  --model <model>             reviewer model (OpenCode default: opencode-go/deepseek-v4-flash)
  --concurrency <number>      maximum parallel AML Agents (default: 6)
  --publish                   allow live GitHub mutations
`
}

function parsedArguments(argv: string[]): { values: Map<string, string>; publish: boolean } {
  const values = new Map<string, string>()
  let publish = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") {
      values.set("help", "true")
      continue
    }
    if (arg === "--publish") {
      publish = true
      continue
    }
    if (!arg?.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`)
    }
    values.set(arg.slice(2), value)
    index += 1
  }
  return { values, publish }
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`${name} is required`)
  }
  return normalized
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function model(options: { values: Map<string, string>; env: NodeJS.ProcessEnv; provider: AmlReviewProvider }): string {
  const modelEnv = options.env.AML_REVIEW_MODEL || options.env.OPENCODE_MODEL
  const configured = options.values.get("model") || modelEnv
  if (configured) {
    return required(configured, "AML_REVIEW_MODEL")
  }
  if (options.provider === "opencode") {
    return "opencode-go/deepseek-v4-flash"
  }
  throw new Error("AML_REVIEW_MODEL is required when AML_REVIEW_PROVIDER=codex")
}

function parseOptions(argv: string[], env: NodeJS.ProcessEnv): CliOptions | null {
  const parsed = parsedArguments(argv)
  if (parsed.values.has("help")) {
    return null
  }
  const repository = required(parsed.values.get("repo") || env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY")
  if (!repository.includes("/")) {
    throw new Error("repository must use owner/name format")
  }
  const workspace = resolve(
    required(parsed.values.get("workspace") || env.WORKSPACE || env.GITHUB_WORKSPACE, "WORKSPACE")
  )
  const provider = parseAmlReviewProvider(parsed.values.get("provider") || env.AML_REVIEW_PROVIDER)
  const codexHome = env.AML_CODEX_HOME?.trim()
  return {
    repository,
    prNumber: positiveInteger(parsed.values.get("pr") || env.PR_NUMBER, "PR_NUMBER"),
    workspace,
    provider,
    model: model({ values: parsed.values, env, provider }),
    ...(codexHome ? { codexHome } : {}),
    concurrency: positiveInteger(parsed.values.get("concurrency") || env.AML_REVIEW_CONCURRENCY || "6", "concurrency"),
    // Live mutation requires an explicit CLI flag; ambient CI variables cannot
    // silently turn a benchmark or local invocation into a publishing run.
    publish: parsed.publish
  }
}

/** Parses the executable edge and emits one complete in-memory result. */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const options = parseOptions(argv, env)
  if (!options) {
    process.stdout.write(usage())
    return
  }

  const token = required(env.GH_TOKEN || env.GITHUB_TOKEN, "GH_TOKEN")
  const github = createAmlGitHubClient({ token, repository: options.repository })
  const trigger = readEventContext({
    eventName: env.GITHUB_EVENT_NAME,
    eventPath: env.GITHUB_EVENT_PATH,
    actor: env.GITHUB_ACTOR
  })
  if (options.publish) {
    const guard = await evaluateGuard({
      github,
      repository: options.repository,
      prNumber: options.prNumber,
      triggerCommentId: trigger.trigger_comment?.id || null
    })
    if (!guard.shouldReview) {
      process.stdout.write(`${JSON.stringify({ status: "skipped", reason: guard.reason })}\n`)
      return
    }
  }

  const result = await runReview({
    request: {
      repository: options.repository,
      prNumber: options.prNumber,
      workspace: options.workspace,
      botLogin: env.REVIEW_BOT_LOGIN || REVIEW_BOT_LOGIN,
      eventName: trigger.event_name,
      eventPath: env.GITHUB_EVENT_PATH || null,
      actor: trigger.actor,
      ignoreHistory: env.REVIEW_IGNORE_HISTORY === "true"
    },
    github,
    actionMode: options.publish ? "live" : "dry-run",
    provider: options.provider,
    model: options.model,
    ...(options.codexHome ? { codexHome: options.codexHome } : {}),
    maximumConcurrency: options.concurrency
  })

  // The result stays in memory; only the Agent-readable evidence files are
  // materialized in the isolated review checkout.
  process.stdout.write(`${JSON.stringify(result)}\n`)

  if (result.publicationStatus === "failed") {
    throw new Error(`review completed but publication failed: ${result.publicationError}`)
  }
}

// Packaged commands enter through a symlink, so compare canonical paths.
const entrypoint = process.argv[1]
if (entrypoint && realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`aml_review: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
