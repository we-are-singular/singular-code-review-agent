import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  cacheEntryDir,
  copyExistingFile,
  fileSize,
  readJsonFile,
  writeJsonFile,
} from "./lib/cache.mjs"
import { loadEvalConfig } from "./lib/config.mjs"
import { loadPullRequestInput, resolveGitHubToken } from "./lib/github.mjs"
import { normalizeEvalModels } from "./lib/models.mjs"
import { normalizeEvalInput, normalizeEvalInputs, parsePrReference, slugify } from "./lib/pr-input.mjs"
import { REVIEW_CACHE_VERSION, reviewCacheKey } from "./lib/review-cache-key.mjs"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const EXTRACTED_ARTIFACTS = [
  "review.md",
  "review_transcript.md",
  "review_comments.json",
  "review_stats.json",
  "docker.stdout.log",
  "docker.stderr.log",
]
const RUNTIME_ARTIFACTS = [
  "review_payload.json",
  "review_validated.json",
  "review_validation_context.json",
  "review_model_context.json",
  "audit_model_context.json",
  "review_queue.json",
  "pr.diff",
  "opencode_review.log",
  "opencode_review.log.jsonl",
  "opencode_audit.log",
  "opencode_audit.log.jsonl",
  "opencode_synthesis.log",
  "opencode_synthesis.log.jsonl",
]
const activeDockerContainers = new Set()

function removeDockerContainer(containerName) {
  if (!containerName) {
    return
  }
  spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" })
  activeDockerContainers.delete(containerName)
}

function cleanupActiveDockerContainers() {
  for (const containerName of Array.from(activeDockerContainers)) {
    removeDockerContainer(containerName)
  }
}

function cleanupStaleDockerContainers() {
  const result = spawnSync(
    "docker",
    ["ps", "--filter", "label=singular-code-review-eval=true", "--format", "{{.Names}}"],
    { encoding: "utf8" },
  )
  if (result.status !== 0) {
    return
  }
  for (const containerName of result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)) {
    spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" })
  }
}

process.on("exit", cleanupActiveDockerContainers)

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanupActiveDockerContainers()
    process.exit(signal === "SIGINT" ? 130 : 143)
  })
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/gu, "-")
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function readJson(file, fallback = null) {
  if (!existsSync(file)) {
    return fallback
  }
  return JSON.parse(readFileSync(file, "utf8"))
}

function writeText(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, value, { mode: 0o600 })
}

function copyRuntimeArtifacts(runtimeDir, artifactDir) {
  mkdirSync(artifactDir, { recursive: true })
  for (const file of RUNTIME_ARTIFACTS) {
    copyExistingFile(join(runtimeDir, file), join(artifactDir, file))
  }
  const auditLog = join(artifactDir, "opencode_audit.log")
  if (fileSize(auditLog) === 0) {
    writeText(auditLog, "Audit phase artifact was not produced by the reviewer runtime. The phase may have been skipped or ended before writing output.\n")
  }
  const auditJsonLog = join(artifactDir, "opencode_audit.log.jsonl")
  if (fileSize(auditJsonLog) === 0) {
    writeText(
      auditJsonLog,
      `${JSON.stringify({
        type: "phase_artifact_missing",
        phase: "audit",
        message: "Audit phase artifact was not produced by the reviewer runtime.",
      })}\n`,
    )
  }
}

function jobFiles(jobDir) {
  const artifactDir = join(jobDir, "artifacts")
  const reviewModelContext = join(artifactDir, "review_model_context.json")
  const prDiff = join(artifactDir, "pr.diff")

  return {
    context: existsSync(reviewModelContext) ? reviewModelContext : "",
    diff: existsSync(prDiff) ? prDiff : "",
    review: existsSync(join(jobDir, "review.md")) ? join(jobDir, "review.md") : "",
    transcript: existsSync(join(jobDir, "review_transcript.md")) ? join(jobDir, "review_transcript.md") : "",
    comments: existsSync(join(jobDir, "review_comments.json")) ? join(jobDir, "review_comments.json") : "",
    stats: existsSync(join(jobDir, "review_stats.json")) ? join(jobDir, "review_stats.json") : "",
    payload: existsSync(join(artifactDir, "review_payload.json")) ? join(artifactDir, "review_payload.json") : "",
    validated: existsSync(join(artifactDir, "review_validated.json")) ? join(artifactDir, "review_validated.json") : "",
    validationContext: existsSync(join(artifactDir, "review_validation_context.json"))
      ? join(artifactDir, "review_validation_context.json")
      : "",
    reviewModelContext: existsSync(reviewModelContext) ? reviewModelContext : "",
    auditModelContext: existsSync(join(artifactDir, "audit_model_context.json"))
      ? join(artifactDir, "audit_model_context.json")
      : "",
    reviewQueue: existsSync(join(artifactDir, "review_queue.json")) ? join(artifactDir, "review_queue.json") : "",
    prDiff: existsSync(prDiff) ? prDiff : "",
    reviewOutput: existsSync(join(artifactDir, "opencode_review.log")) ? join(artifactDir, "opencode_review.log") : "",
    reviewJsonOutput: existsSync(join(artifactDir, "opencode_review.log.jsonl"))
      ? join(artifactDir, "opencode_review.log.jsonl")
      : "",
    auditOutput: existsSync(join(artifactDir, "opencode_audit.log")) ? join(artifactDir, "opencode_audit.log") : "",
    auditJsonOutput: existsSync(join(artifactDir, "opencode_audit.log.jsonl"))
      ? join(artifactDir, "opencode_audit.log.jsonl")
      : "",
    synthesisOutput: existsSync(join(artifactDir, "opencode_synthesis.log"))
      ? join(artifactDir, "opencode_synthesis.log")
      : "",
    synthesisJsonOutput: existsSync(join(artifactDir, "opencode_synthesis.log.jsonl"))
      ? join(artifactDir, "opencode_synthesis.log.jsonl")
      : "",
    stdout: existsSync(join(jobDir, "docker.stdout.log")) ? join(jobDir, "docker.stdout.log") : "",
    stderr: existsSync(join(jobDir, "docker.stderr.log")) ? join(jobDir, "docker.stderr.log") : "",
  }
}

function runProcess({ command, args, cwd, env, stdoutFile, stderrFile, timeoutMs }) {
  return new Promise((resolveRun) => {
    mkdirSync(dirname(stdoutFile), { recursive: true })
    mkdirSync(dirname(stderrFile), { recursive: true })
    const stdout = createWriteStream(stdoutFile, { mode: 0o600 })
    const stderr = createWriteStream(stderrFile, { mode: 0o600 })
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let settled = false
    let timedOut = false
    let errorMessage = ""
    const finish = (status) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      stdout.end()
      stderr.end()
      resolveRun({
        status: status ?? 1,
        error: timedOut ? `${command} timed out after ${timeoutMs}ms` : errorMessage || (status === 0 ? null : `${command} exited ${status}`),
      })
    }
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill("SIGTERM")
          setTimeout(() => {
            if (!settled) {
              child.kill("SIGKILL")
            }
          }, 5_000).unref()
        }, timeoutMs).unref()
      : null

    child.stdout.pipe(stdout)
    child.stderr.pipe(stderr)
    child.on("error", (error) => {
      errorMessage = error.message
      finish(1)
    })
    child.on("close", (status) => finish(status))
  })
}

async function buildDockerImage({ image }) {
  const stdoutFile = resolve(repoRoot, "eval", "runs", ".docker-build.stdout.log")
  const stderrFile = resolve(repoRoot, "eval", "runs", ".docker-build.stderr.log")
  console.log(`building reviewer image ${image}`)
  const run = await runProcess({
    command: "docker",
    args: ["build", "-t", image, "."],
    cwd: repoRoot,
    env: process.env,
    stdoutFile,
    stderrFile,
    timeoutMs: 30 * 60_000,
  })
  if (run.status !== 0) {
    throw new Error(`docker build failed: ${run.error}; logs: ${stdoutFile}, ${stderrFile}`)
  }
}

function reviewBodyFromComments(comments) {
  const review = comments?.review && typeof comments.review === "object" ? comments.review : {}
  return String(review.body || "").trim()
}

function reviewExportCounts(comments) {
  return [
    comments.issueComments,
    comments.inlineComments,
    comments.replies,
  ].reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0)
}

function readCaptureFailure({ run, commentsFile, artifactDir }) {
  if (run.status !== 0) {
    return run.error || `dry-run exited ${run.status}`
  }

  const comments = readJson(commentsFile, {})
  const body = reviewBodyFromComments(comments)
  const producedFeedback = reviewExportCounts(comments)
  const reviewJsonOutput = existsSync(join(artifactDir, "opencode_review.log.jsonl"))
    ? readFileSync(join(artifactDir, "opencode_review.log.jsonl"), "utf8")
    : ""
  const synthesisJsonOutput = existsSync(join(artifactDir, "opencode_synthesis.log.jsonl"))
    ? readFileSync(join(artifactDir, "opencode_synthesis.log.jsonl"), "utf8")
    : ""
  if (/"type"\s*:\s*"error"/u.test(reviewJsonOutput) || /"type"\s*:\s*"error"/u.test(synthesisJsonOutput)) {
    return "OpenCode phase emitted an error event"
  }
  if (!body || /synthesis pass did not produce a body/iu.test(body)) {
    return "review synthesis did not produce a final body"
  }
  if (
    producedFeedback === 0 &&
    /incomplete review|access limitations|access restrictions|could not complete|did not successfully complete|no (?:new )?(?:inline comments|actionable findings)|queue shows no/iu.test(body)
  ) {
    return "review synthesis reported an incomplete review"
  }
  return null
}

function renderCommentList(title, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return `## ${title}\n\nNone.\n`
  }
  return `## ${title}\n\n${items
    .map((item, index) => {
      const record = item && typeof item === "object" ? item : {}
      const location = [record.path, record.line].filter(Boolean).join(":")
      const heading = location ? `${index + 1}. ${location}` : `${index + 1}.`
      const body = String(record.body || JSON.stringify(item, null, 2)).trim()
      return `${heading}\n\n${body}`
    })
    .join("\n\n")}\n`
}

function writeCandidateReview({ commentsFile, reviewFile }) {
  const comments = readJson(commentsFile, {})
  const body = reviewBodyFromComments(comments) || "_No final review body was produced._"
  const text = [
    "# Final Review Body",
    body,
    renderCommentList("Issue Comments", comments.issueComments),
    renderCommentList("Inline Comments", comments.inlineComments),
    renderCommentList("Replies", comments.replies),
    renderCommentList("Dropped Comments", comments.dropped),
    "",
  ].join("\n\n")
  writeText(reviewFile, text)
}

function parseArgs(argv) {
  const options = {
    outDir: resolve(repoRoot, "eval", "runs", timestamp()),
    configFile: resolve(repoRoot, "eval", "config.ts"),
    models: [],
    prs: [],
    concurrency: undefined,
    reviewTimeoutMs: undefined,
    bootTimeoutMs: undefined,
    keepScratch: undefined,
    append: false,
    force: false,
    cacheDir: resolve(repoRoot, "eval", "cache", "reviews"),
    useConfigInput: true,
    image: "singular-code-review:eval",
    skipBuild: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--out") {
      options.outDir = resolve(argv[++index])
    } else if (arg === "--config") {
      options.configFile = resolve(argv[++index])
    } else if (arg === "--model") {
      options.models.push(argv[++index])
    } else if (arg === "--pr") {
      options.prs.push(argv[++index])
    } else if (arg === "--concurrency") {
      options.concurrency = Number(argv[++index])
    } else if (arg === "--review-timeout-ms") {
      options.reviewTimeoutMs = Number(argv[++index])
    } else if (arg === "--boot-timeout-ms") {
      options.bootTimeoutMs = Number(argv[++index])
    } else if (arg === "--keep-scratch") {
      options.keepScratch = true
    } else if (arg === "--append") {
      options.append = true
    } else if (arg === "--force") {
      options.force = true
    } else if (arg === "--cache-dir") {
      options.cacheDir = resolve(argv[++index])
    } else if (arg === "--image") {
      options.image = argv[++index] || ""
    } else if (arg === "--skip-build") {
      options.skipBuild = true
    } else if (arg === "--no-config-input") {
      options.useConfigInput = false
    } else if (arg === "--help" || arg === "-h") {
      options.help = true
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }

  return options
}

function printHelp() {
  console.log(`Usage: node eval/run.mjs [options]

Capture production dry-run reviews only. Judging and reports are separate commands.

Options:
  --out <dir>               Output directory. Default: eval/runs/<timestamp>
  --config <file>           Eval config. Default: eval/config.ts
  --pr <owner/repo/123>     Add one PR without editing config. Can repeat.
  --model <model>           Override model matrix. Can repeat.
  --concurrency <n>         Concurrent captures. Default: config or 1
  --review-timeout-ms <ms>  Per review timeout. Default: config or 600000
  --boot-timeout-ms <ms>    Kill model if OpenCode emits no output. Default: config or 90000
  --keep-scratch            Keep temporary checkout/HOME/XDG for debugging
  --append                  Add missing PR x model jobs to an existing --out run
  --force                   Bypass the global review cache for jobs that run
  --cache-dir <dir>         Global review cache. Default: eval/cache/reviews
  --image <tag>             Docker image tag. Default: singular-code-review:eval
  --skip-build              Use the existing image instead of building Dockerfile
  --no-config-input         Use only --pr values, ignoring config.input
`)
}

function positiveInteger(value, fallback, name) {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return number
}

function resolveModels(options, config) {
  let models = []
  if (options.models.length > 0) {
    models = options.models
  } else if (Array.isArray(config.models) && config.models.length > 0) {
    models = config.models
  }
  if (models.length === 0) {
    throw new Error("no models configured; set config.models or pass --model")
  }
  return normalizeEvalModels(models)
}

function resolveInputs(options, config) {
  const inputs = options.useConfigInput ? normalizeEvalInputs(config.input || []) : []
  for (const ref of options.prs) {
    const parsed = parsePrReference(ref)
    if (!parsed) {
      throw new Error(`unsupported PR reference: ${ref}`)
    }
    inputs.push(normalizeEvalInput({ pr: ref, ignoreHistory: true }, inputs.length))
  }
  if (inputs.length === 0) {
    throw new Error("no PR inputs configured; set config.input or pass --pr")
  }
  return inputs
}

function jobKey(job) {
  return `${job.input.slug}__${slugify(job.model)}`
}

function jobArtifactsExist(outDir, job) {
  const key = jobKey(job)
  const jobDir = join(outDir, "jobs", key)
  return (
    existsSync(join(jobDir, "result.json")) &&
    existsSync(join(jobDir, "review.md")) &&
    existsSync(join(jobDir, "review_transcript.md")) &&
    existsSync(join(jobDir, "review_comments.json")) &&
    existsSync(join(jobDir, "review_stats.json")) &&
    existsSync(join(jobDir, "artifacts", "pr.diff")) &&
    existsSync(join(jobDir, "artifacts", "review_model_context.json"))
  )
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value)))
}

function mergeInputs(existing, next) {
  const byKey = new Map()
  for (const input of [...existing, ...next]) {
    const key = input?.slug || input?.ref || JSON.stringify(input)
    byKey.set(key, input)
  }
  return Array.from(byKey.values())
}

function restoreReviewCache({ cacheDir, jobDir, job, key, startedAt }) {
  const entryDir = cacheEntryDir(cacheDir, key)
  const manifest = readJsonFile(join(entryDir, "cache.json"))
  if (
    !manifest ||
    manifest.status !== "completed" ||
    manifest.version !== REVIEW_CACHE_VERSION ||
    !existsSync(join(entryDir, "review.md")) ||
    !existsSync(join(entryDir, "review_comments.json")) ||
    !existsSync(join(entryDir, "review_stats.json")) ||
    !existsSync(join(entryDir, "artifacts", "pr.diff")) ||
    !existsSync(join(entryDir, "artifacts", "review_model_context.json"))
  ) {
    return null
  }

  for (const file of EXTRACTED_ARTIFACTS) {
    copyExistingFile(join(entryDir, file), join(jobDir, file))
  }
  for (const file of RUNTIME_ARTIFACTS) {
    copyExistingFile(join(entryDir, "artifacts", file), join(jobDir, "artifacts", file))
  }

  const result = {
    status: "completed",
    error: null,
    model: job.model,
    input: job.input,
    startedAt,
    endedAt: new Date().toISOString(),
    outputBytes: fileSize(join(jobDir, "review.md")),
    files: jobFiles(jobDir),
    scratch: null,
    cache: {
      hit: true,
      key,
      dir: entryDir,
    },
  }
  writeJson(join(jobDir, "result.json"), result)
  return result
}

function saveReviewCache({ cacheDir, key, jobDir, result, job }) {
  if (result.status !== "completed" || result.outputBytes <= 0) {
    return
  }
  const entryDir = cacheEntryDir(cacheDir, key)
  for (const file of EXTRACTED_ARTIFACTS) {
    copyExistingFile(join(jobDir, file), join(entryDir, file))
  }
  for (const file of RUNTIME_ARTIFACTS) {
    copyExistingFile(join(jobDir, "artifacts", file), join(entryDir, "artifacts", file))
  }
  writeJsonFile(join(entryDir, "cache.json"), {
    version: REVIEW_CACHE_VERSION,
    capture: "docker-review-dry-run",
    status: "completed",
    key,
    model: job.model,
    input: job.input,
    outputBytes: result.outputBytes,
    createdAt: new Date().toISOString(),
  })
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function writeRunFile({ outDir, runConfig, preservedJobs, results }) {
  writeJson(join(outDir, "run.json"), {
    ...runConfig,
    endedAt: new Date().toISOString(),
    jobs: [...preservedJobs, ...results.filter(Boolean)],
  })
}

async function runJob(job, options) {
  const jobSlug = `${job.input.slug}__${slugify(job.model)}`
  const jobDir = join(options.outDir, "jobs", jobSlug)
  const reviewFile = join(jobDir, "review.md")
  const transcriptFile = join(jobDir, "review_transcript.md")
  const commentsFile = join(jobDir, "review_comments.json")
  const statsFile = join(jobDir, "review_stats.json")
  const stdoutFile = join(jobDir, "docker.stdout.log")
  const stderrFile = join(jobDir, "docker.stderr.log")
  const artifactDir = join(jobDir, "artifacts")
  const containerName = `singular-eval-${process.pid}-${job.index}-${Date.now()}`
  // Keep the live checkout outside the output mount. Otherwise Docker exposes
  // it through both the permitted runtime path and `/eval-output`, which makes
  // OpenCode reject a discovered alias as an external directory.
  const runtimeDir = join(tmpdir(), "singular-code-review-eval", containerName)

  mkdirSync(jobDir, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true })

  const startedAt = new Date().toISOString()
  console.log(`[${job.index + 1}/${job.total}] ${job.input.ref} ${job.model}`)

  try {
    const loaded = await loadPullRequestInput(job.input, options.githubToken)
    const cacheKey = reviewCacheKey({
      model: job.model,
      input: job.input,
      context: loaded.context,
      diffText: loaded.diffText,
    })

    if (!options.force) {
      const cached = restoreReviewCache({
        cacheDir: options.cacheDir,
        jobDir,
        job,
        key: cacheKey,
        startedAt,
      })
      if (cached) {
        console.log(`cache hit ${job.input.ref} ${job.model}`)
        return cached
      }
    }

    const dockerArgs = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--label",
      "singular-code-review-eval=true",
      "--entrypoint",
      "/usr/local/bin/review_dry_run",
      "--env",
      "GH_TOKEN",
      "--env",
      "OPENCODE_API_KEY",
      "--env",
      "OPENROUTER_API_KEY",
      "--env",
      "OPENCODE_MODEL",
      "--env",
      "REVIEW_IGNORE_HISTORY",
      "--volume",
      `${jobDir}:/eval-output`,
      "--volume",
      `${runtimeDir}:/tmp/.singular-code-review/eval-runtime`,
      options.image,
      job.input.repository,
      String(job.input.number),
      "--runtime-dir",
      "/tmp/.singular-code-review/eval-runtime",
      "--out-dir",
      "/eval-output",
    ]
    if (typeof process.getuid === "function" && typeof process.getgid === "function") {
      dockerArgs.splice(4, 0, "--user", `${process.getuid()}:${process.getgid()}`)
    }

    activeDockerContainers.add(containerName)
    const run = await runProcess({
      command: "docker",
      args: dockerArgs,
      cwd: repoRoot,
      env: {
        ...process.env,
        GH_TOKEN: options.githubToken,
        OPENCODE_MODEL: job.model,
        REVIEW_IGNORE_HISTORY: job.input.ignoreHistory ? "true" : "false",
      },
      stdoutFile,
      stderrFile,
      timeoutMs: options.reviewTimeoutMs,
    })
    copyRuntimeArtifacts(runtimeDir, artifactDir)
    if (run.status === 0 && existsSync(commentsFile) && existsSync(statsFile) && existsSync(transcriptFile)) {
      writeCandidateReview({ commentsFile, reviewFile })
    }
    const outputBytes = fileSize(reviewFile)
    const captureFailure = readCaptureFailure({ run, commentsFile, artifactDir })

    const result = {
      status: !captureFailure && outputBytes > 0 ? "completed" : "failed",
      error: !captureFailure && outputBytes > 0 ? null : captureFailure || "dry-run review output was empty",
      model: job.model,
      input: job.input,
      startedAt,
      endedAt: new Date().toISOString(),
      outputBytes,
      files: jobFiles(jobDir),
      scratch: null,
      cache: {
        hit: false,
        key: cacheKey,
        dir: cacheEntryDir(options.cacheDir, cacheKey),
      },
    }
    writeJson(join(jobDir, "result.json"), result)
    saveReviewCache({ cacheDir: options.cacheDir, key: cacheKey, jobDir, result, job })
    return result
  } catch (error) {
    const result = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      model: job.model,
      input: job.input,
      startedAt,
      endedAt: new Date().toISOString(),
      outputBytes: 0,
      files: jobFiles(jobDir),
      scratch: null,
      cache: null,
    }
    writeJson(join(jobDir, "result.json"), result)
    return result
  } finally {
    removeDockerContainer(containerName)
    rmSync(runtimeDir, { recursive: true, force: true })
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const config = await loadEvalConfig(options.configFile)
  const models = resolveModels(options, config)
  const inputs = resolveInputs(options, config)
  const concurrency = positiveInteger(options.concurrency, config.concurrency, "concurrency")
  const reviewTimeoutMs = positiveInteger(options.reviewTimeoutMs, config.reviewTimeoutMs, "reviewTimeoutMs")
  const bootTimeoutMs = positiveInteger(options.bootTimeoutMs, config.bootTimeoutMs, "bootTimeoutMs")
  const keepScratch = options.keepScratch ?? config.keepScratch
  const githubToken = await resolveGitHubToken(process.env)
  const runFile = join(options.outDir, "run.json")
  const existingRun = options.append ? readJson(runFile, null) : null
  if (!options.append && existsSync(runFile)) {
    throw new Error(`run already exists at ${options.outDir}; pass --append or choose a new --out directory`)
  }
  const startedAt = existingRun?.startedAt || new Date().toISOString()

  mkdirSync(options.outDir, { recursive: true })
  cleanupStaleDockerContainers()
  if (!options.skipBuild) {
    await buildDockerImage({ image: options.image })
  }
  const runConfig = {
    startedAt,
    configFile: options.configFile,
    models: uniqueStrings([...(existingRun?.models || []), ...models]),
    inputs: mergeInputs(existingRun?.inputs || [], inputs),
    concurrency,
    reviewTimeoutMs,
    bootTimeoutMs,
    keepScratch,
    cacheDir: options.cacheDir,
    image: options.image,
    skipBuild: options.skipBuild,
  }
  writeJson(join(options.outDir, "run-config.json"), runConfig)

  const existingJobs = existingRun?.jobs || []
  const completedJobKeys = new Set(
    options.force
      ? []
      : existingJobs.filter((job) => job.status === "completed" && jobArtifactsExist(options.outDir, job)).map(jobKey),
  )
  const requestedJobs = inputs.flatMap((input) => models.map((model) => ({ input, model })))
  const duplicateJobs = requestedJobs.filter((job) => completedJobKeys.has(jobKey(job)))
  const jobs = requestedJobs.filter((job) => !completedJobKeys.has(jobKey(job)))
  const rerunJobKeys = new Set(jobs.map(jobKey))
  const preservedJobs = existingJobs.filter((job) => !rerunJobKeys.has(jobKey(job)))
  const completedResults = []
  for (const job of duplicateJobs) {
    console.log(`skipping existing ${job.input.ref} ${job.model}`)
  }
  writeRunFile({ outDir: options.outDir, runConfig, preservedJobs, results: completedResults })
  const results = await runPool(
    jobs.map((job, index) => ({ ...job, index, total: jobs.length })),
    concurrency,
    async (job) => {
      const result = await runJob(job, {
        outDir: options.outDir,
        githubToken,
        reviewTimeoutMs,
        bootTimeoutMs,
        keepScratch,
        force: options.force,
        cacheDir: options.cacheDir,
        image: options.image,
      })
      completedResults.push(result)
      writeRunFile({ outDir: options.outDir, runConfig, preservedJobs, results: completedResults })
      return result
    },
  )

  writeRunFile({ outDir: options.outDir, runConfig, preservedJobs, results })

  const completed = results.filter((result) => result.status === "completed").length
  console.log(`captured ${completed}/${results.length} new reviews`)
  console.log(`run: ${options.outDir}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
