#!/usr/bin/env node
import { execFile } from "node:child_process"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs, promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { parseReviewProvider, type ReviewProvider } from "../lib/review-provider.js"
import { runReview } from "../run-review.js"
import { createGitHubClient } from "../services/github-client.js"
import { DEFAULT_REVIEW_BOT_LOGIN, ReviewEvidence } from "../services/review-evidence.js"
import { ReviewPreflight } from "../services/review-preflight.js"

type CliOptions = {
  repository: string
  prNumber: number
  workspace: string
  provider: ReviewProvider
  model: string
  reasoningEffort?: string
  codexHome?: string
  concurrency: number
  publish: boolean
}

const execFileAsync = promisify(execFile)

function usage(): string {
  return `usage: review_runner --repo <owner/repo> --pr <number> [options]

Runs the review in memory. GitHub mutations are recorded by default; pass
--publish explicitly to execute the exact validated publication plan.

Options:
  --workspace <path>          checked-out pull request workspace
  --provider <name>           Agent provider: opencode or codex (default: opencode)
  --model <model>             reviewer model (OpenCode default: opencode-go/deepseek-v4-flash)
  --concurrency <number>      maximum parallel AML Agents (default: 6)
  --publish                   allow live GitHub mutations
`
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

export function parseModelSpec(value: string): { model: string; reasoningEffort?: string } {
  const separator = value.indexOf(":")
  if (separator === -1) {
    return { model: value }
  }

  const model = value.slice(0, separator)
  const reasoningEffort = value.slice(separator + 1)
  return reasoningEffort ? { model, reasoningEffort } : { model }
}

function model(options: {
  configured?: string
  env: NodeJS.ProcessEnv
  provider: ReviewProvider
}): { model: string; reasoningEffort?: string } {
  const modelEnv = options.env.REVIEW_MODEL || options.env.OPENCODE_MODEL
  const configured = options.configured || modelEnv
  if (configured) {
    return parseModelSpec(required(configured, "REVIEW_MODEL"))
  }
  if (options.provider === "opencode") {
    return { model: "opencode-go/deepseek-v4-flash" }
  }
  throw new Error("REVIEW_MODEL is required when REVIEW_PROVIDER=codex")
}

function parseOptions(argv: string[], env: NodeJS.ProcessEnv): CliOptions | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      concurrency: { type: "string" },
      help: { type: "boolean", short: "h" },
      model: { type: "string" },
      pr: { type: "string" },
      provider: { type: "string" },
      publish: { type: "boolean" },
      repo: { type: "string" },
      workspace: { type: "string" }
    },
    strict: true
  })
  if (values.help) {
    return null
  }
  const repository = required(values.repo || env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY")
  if (!repository.includes("/")) {
    throw new Error("repository must use owner/name format")
  }
  const workspace = resolve(required(values.workspace || env.WORKSPACE || env.GITHUB_WORKSPACE, "WORKSPACE"))
  const provider = parseReviewProvider(values.provider || env.REVIEW_PROVIDER)
  const codexHome = env.REVIEW_CODEX_HOME?.trim()
  const modelSpec = model({ configured: values.model, env, provider })
  if (provider !== "codex" && modelSpec.reasoningEffort) {
    throw new Error("model reasoning suffixes require REVIEW_PROVIDER=codex")
  }
  return {
    repository,
    prNumber: positiveInteger(values.pr || env.PR_NUMBER, "PR_NUMBER"),
    workspace,
    provider,
    ...modelSpec,
    ...(codexHome ? { codexHome } : {}),
    concurrency: positiveInteger(values.concurrency || env.REVIEW_CONCURRENCY || "6", "concurrency"),
    // Live mutation requires an explicit CLI flag; ambient CI variables cannot
    // silently turn a benchmark or local invocation into a publishing run.
    publish: values.publish || false
  }
}

/** Reads the exact commit whose surrounding source the Agents will inspect. */
async function checkedOutHead(workspace: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" })
    const head = stdout.trim()
    if (/^[0-9a-f]{40}$/u.test(head)) {
      return head
    }
  } catch (cause) {
    throw new Error(`cannot read the checked-out commit in ${workspace}`, { cause })
  }
  throw new Error(`git returned an invalid checked-out commit in ${workspace}`)
}

/** Parses the executable edge and emits one complete in-memory result. */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const options = parseOptions(argv, env)
  if (!options) {
    process.stdout.write(usage())
    return
  }

  const token = required(env.GH_TOKEN || env.GITHUB_TOKEN, "GH_TOKEN")
  const github = createGitHubClient({ token, repository: options.repository })
  const trigger = ReviewEvidence.trigger({
    eventName: env.GITHUB_EVENT_NAME || null,
    eventPath: env.GITHUB_EVENT_PATH || null,
    actor: env.GITHUB_ACTOR || null
  })
  const triggerCommentId = env.TRIGGER_COMMENT_ID ? positiveInteger(env.TRIGGER_COMMENT_ID, "TRIGGER_COMMENT_ID") : null
  if (options.publish) {
    // The reusable workflow checks before checkout; direct --publish CLI runs
    // do not, so the mutation boundary repeats the same reusable policy.
    const guard = await new ReviewPreflight({
      github,
      repository: options.repository,
      prNumber: options.prNumber
    }).evaluate(trigger.comment?.id || triggerCommentId)
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
      workspaceHeadSha: await checkedOutHead(options.workspace),
      botLogin: env.REVIEW_BOT_LOGIN || DEFAULT_REVIEW_BOT_LOGIN,
      eventName: trigger.eventName,
      eventPath: env.GITHUB_EVENT_PATH || null,
      actor: trigger.actor,
      triggerCommentId,
      ignoreHistory: env.REVIEW_IGNORE_HISTORY === "true"
    },
    github,
    actionMode: options.publish ? "live" : "dry-run",
    provider: options.provider,
    model: options.model,
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
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
    process.stderr.write(`review_runner: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
