import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir, tmpdir } from "node:os"
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
import { normalizeEvalInput, normalizeEvalInputs, parsePrReference } from "./lib/pr-input.mjs"
import { REVIEW_CACHE_VERSION, reviewCacheKey } from "./lib/review-cache-key.mjs"
import {
  normalizeAmlReviewProvider,
  normalizeReviewRunner,
  reviewerContainerConfig,
} from "./lib/reviewer-runner.mjs"
import { evalJobKey } from "./lib/job-key.mjs"
import { readAmlResult, writeAmlArtifacts } from "./lib/aml-artifacts.mjs"
import { canonicalJobArtifacts, completedJobArtifacts } from "./lib/job-artifacts.mjs"
import { stageOpenCodeAuth } from "./lib/opencode-auth.mjs"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_BASE_IMAGE =
  "docker.io/wearesingular/aml-agent-sandbox@sha256:5b9724161e815b67d2bde72f9157d651b763c1b39e535b287bede8d90a874f9f"
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
const EVAL_OWNER_LABEL = "singular-code-review-eval-owner"
const EVAL_OWNER_ID = randomUUID()
const EVAL_OWNER_DIR = join(tmpdir(), "singular-code-review-eval", "owners")
const EVAL_OWNER_LEASE = join(EVAL_OWNER_DIR, EVAL_OWNER_ID)
const OWNER_HEARTBEAT_MS = 5_000
const OWNER_STALE_AFTER_MS = 15_000
let ownerHeartbeat = null

/** Keeps evaluator ownership valid across isolated PID namespaces. */
function startOwnerLease() {
  mkdirSync(EVAL_OWNER_DIR, { recursive: true })
  writeFileSync(EVAL_OWNER_LEASE, `${new Date().toISOString()}\n`, { mode: 0o600 })
  ownerHeartbeat = setInterval(() => {
    try {
      const now = new Date()
      utimesSync(EVAL_OWNER_LEASE, now, now)
    } catch {
      // A later heartbeat recreates no authority after the lease is removed.
    }
  }, OWNER_HEARTBEAT_MS)
  ownerHeartbeat.unref()
}

/** Removes the ownership lease after active containers have been reaped. */
function stopOwnerLease() {
  if (ownerHeartbeat) {
    clearInterval(ownerHeartbeat)
    ownerHeartbeat = null
  }
  rmSync(EVAL_OWNER_LEASE, { force: true })
}

function removeDockerContainer(containerName) {
  if (!containerName) {
    return
  }
  // Keep failed removals tracked for the signal/exit batch while bounding a
  // Docker daemon that is refusing to reap the review container.
  const cleanup = spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore", timeout: 10_000 })
  if (cleanup.status === 0) {
    activeDockerContainers.delete(containerName)
  }
}

function cleanupActiveDockerContainers() {
  const containerNames = Array.from(activeDockerContainers)
  if (containerNames.length === 0) {
    return
  }

  // Exit handlers cannot wait for the detached cleanup used during ordinary
  // jobs. Bound one synchronous batch so Ctrl-C cannot leave paid inference
  // containers running after the evaluator exits.
  const cleanup = spawnSync("docker", ["rm", "-f", ...containerNames], { stdio: "ignore", timeout: 10_000 })
  if (cleanup.status === 0) {
    activeDockerContainers.clear()
  }
}

function cleanupStaleDockerContainers() {
  const result = spawnSync(
    "docker",
    [
      "ps",
      "--filter",
      "label=singular-code-review-eval=true",
      "--format",
      `{{.Names}}\t{{.Label "${EVAL_OWNER_LABEL}"}}`,
    ],
    { encoding: "utf8" },
  )
  if (result.status !== 0) {
    return
  }

  for (const line of result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
    const [containerName, ownerId] = line.split("\t")
    if (!containerName || !isOrphanedEvalContainer(ownerId)) {
      continue
    }
    spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" })
  }
}

/** Keeps concurrent evaluators alive while still reaping containers from dead owners. */
function isOrphanedEvalContainer(ownerId, leaseIsFresh = defaultOwnerLeaseIsFresh) {
  return typeof ownerId === "string" && ownerId.length > 0 && !leaseIsFresh(ownerId)
}

function defaultOwnerLeaseIsFresh(ownerId) {
  // Docker labels are external input. Restrict the value before resolving it
  // beneath the shared lease directory.
  if (!/^[a-zA-Z0-9-]+$/u.test(ownerId)) {
    return false
  }
  try {
    return Date.now() - statSync(join(EVAL_OWNER_DIR, ownerId)).mtimeMs <= OWNER_STALE_AFTER_MS
  } catch {
    return false
  }
}

process.on("exit", () => {
  cleanupActiveDockerContainers()
  stopOwnerLease()
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanupActiveDockerContainers()
    stopOwnerLease()
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

function copyRuntimeArtifacts(runtimeDir, artifactDir, runner) {
  mkdirSync(artifactDir, { recursive: true })
  for (const file of RUNTIME_ARTIFACTS) {
    copyExistingFile(join(runtimeDir, file), join(artifactDir, file))
  }
  if (runner === "aml") {
    return
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

function jobFiles(jobDir, runner) {
  const artifactDir = join(jobDir, "artifacts")
  const reviewModelContext = join(artifactDir, "review_model_context.json")
  const prDiff = join(artifactDir, "pr.diff")
  const canonical = {
    context: existsSync(reviewModelContext) ? reviewModelContext : "",
    diff: existsSync(prDiff) ? prDiff : "",
    review: existsSync(join(jobDir, "review.md")) ? join(jobDir, "review.md") : "",
    transcript: existsSync(join(jobDir, "review_transcript.md")) ? join(jobDir, "review_transcript.md") : "",
    comments: existsSync(join(jobDir, "review_comments.json")) ? join(jobDir, "review_comments.json") : "",
    stats: existsSync(join(jobDir, "review_stats.json")) ? join(jobDir, "review_stats.json") : "",
    stdout: existsSync(join(jobDir, "docker.stdout.log")) ? join(jobDir, "docker.stdout.log") : "",
    stderr: existsSync(join(jobDir, "docker.stderr.log")) ? join(jobDir, "docker.stderr.log") : "",
  }
  if (runner === "aml") {
    return canonical
  }

  return {
    ...canonical,
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
      detached: true,
    })
    let settled = false
    let timedOut = false
    let errorMessage = ""
    let escalationTimer = null
    const finish = (status) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (!timedOut && escalationTimer) {
        clearTimeout(escalationTimer)
      }
      child.stdout.unpipe(stdout)
      child.stderr.unpipe(stderr)
      stdout.end()
      stderr.end()
      resolveRun({
        status: status ?? 1,
        error: timedOut ? `${command} timed out after ${timeoutMs}ms` : errorMessage || (status === 0 ? null : `${command} exited ${status}`),
        timedOut,
      })
    }
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true
          const signalGroup = (signal) => {
            if (!child.pid) {
              return
            }
            try {
              process.kill(-child.pid, signal)
            } catch (error) {
              if (error?.code !== "ESRCH") {
                child.kill(signal)
              }
            }
          }
          signalGroup("SIGTERM")
          escalationTimer = setTimeout(() => signalGroup("SIGKILL"), 5_000)
          escalationTimer.unref()
          // Docker may never emit `close` after a daemon or container hang.
          // Resolve at the safety boundary so the worker can record failure
          // and release the pool; the escalation above still reaps the child.
          finish(1)
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

async function buildDockerImage({ image, baseImage }) {
  const stdoutFile = resolve(repoRoot, "eval", "runs", ".docker-build.stdout.log")
  const stderrFile = resolve(repoRoot, "eval", "runs", ".docker-build.stderr.log")
  console.log(`building reviewer image ${image}`)
  const args = ["build", "-t", image]
  if (baseImage) {
    args.push("--build-arg", `BASE_IMAGE=${baseImage}`)
  }
  args.push(".")
  const run = await runProcess({
    command: "docker",
    args,
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

/** Resolves mutable local tags so the run manifest records exact image inputs. */
function dockerImageId(image) {
  const result = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
    encoding: "utf8",
  })
  const id = result.status === 0 ? result.stdout.trim() : ""
  if (!id) {
    throw new Error(`could not resolve Docker image ${image}`)
  }
  return id
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

function readCaptureFailure({ run, commentsFile, artifactDir, runner }) {
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
  if (runner === "src" && (/"type"\s*:\s*"error"/u.test(reviewJsonOutput) || /"type"\s*:\s*"error"/u.test(synthesisJsonOutput))) {
    return "OpenCode phase emitted an error event"
  }
  if (!body || /synthesis pass did not produce a body/iu.test(body)) {
    return "review synthesis did not produce a final body"
  }
  // AML stdout has already passed its typed result parser. Only the legacy
  // source runner needs a prose heuristic for otherwise silent failures.
  if (
    runner === "src" &&
    producedFeedback === 0 &&
    /incomplete review|access limitations|access restrictions|could not complete|did not successfully complete|no new inline comments|queue shows no/iu.test(body)
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
    runner: undefined,
    amlProvider: undefined,
    prs: [],
    concurrency: undefined,
    targetDurationMs: undefined,
    reviewTimeoutMs: undefined,
    keepScratch: undefined,
    append: false,
    force: false,
    cacheDir: resolve(repoRoot, "eval", "cache", "reviews"),
    useConfigInput: true,
    image: "singular-code-review:eval",
    baseImage: undefined,
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
    } else if (arg === "--runner") {
      options.runner = argv[++index] || ""
    } else if (arg === "--aml-provider") {
      options.amlProvider = argv[++index] || ""
    } else if (arg === "--pr") {
      options.prs.push(argv[++index])
    } else if (arg === "--concurrency") {
      options.concurrency = Number(argv[++index])
    } else if (arg === "--target-duration-ms") {
      options.targetDurationMs = Number(argv[++index])
    } else if (arg === "--review-timeout-ms") {
      options.reviewTimeoutMs = Number(argv[++index])
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
    } else if (arg === "--base-image") {
      options.baseImage = argv[++index] || ""
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
  --runner <src|aml>        Reviewer implementation. Default: src.
  --aml-provider <name>     AML Agent provider: opencode or codex. Default: opencode.
  --concurrency <n>         Concurrent captures. Default: config or 1
  --target-duration-ms <ms> Advisory duration target. Default: config or 600000
  --review-timeout-ms <ms>  Hard per-review safety timeout. Default: config or 1800000 (30 minutes)
  --keep-scratch            Keep temporary checkout/HOME/XDG for debugging
  --append                  Add missing PR x model jobs to an existing --out run
  --force                   Bypass the global review cache for jobs that run
  --cache-dir <dir>         Global review cache. Default: eval/cache/reviews
  --image <tag>             Docker image tag. Default: singular-code-review:eval
  --base-image <tag>        AML base image. Default: published sandbox 0.3.1 digest
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

function resolveModels(options, config, runner, amlProvider) {
  let models = []
  if (options.models.length > 0) {
    models = options.models
  } else if (Array.isArray(config.models) && config.models.length > 0) {
    models = config.models
  }
  if (models.length === 0) {
    throw new Error("no models configured; set config.models or pass --model")
  }
  const defaultProvider = runner === "aml" && amlProvider === "codex" ? "" : "opencode-go"
  return normalizeEvalModels(models, defaultProvider)
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

/** Determines whether an appended job was captured with identical input semantics. */
function sameCaptureJob(existing, requested) {
  return (
    evalJobKey(existing) === evalJobKey(requested) &&
    Boolean(existing.input.ignoreHistory) === Boolean(requested.input.ignoreHistory) &&
    (existing.input.label || "") === (requested.input.label || "") &&
    (existing.input.notes || "") === (requested.input.notes || "")
  )
}

/** Prevents completed captures from crossing an unverifiable reviewer image boundary. */
function validateAppendImageIdentity(existingRun, { image, imageId, baseImage, baseImageId }) {
  if (!existingRun) {
    return
  }

  const hasCompletedJobs = (existingRun.jobs || []).some((job) => job.status === "completed")
  if (hasCompletedJobs && (!existingRun.imageId || !existingRun.baseImageId)) {
    throw new Error("cannot append a legacy run with completed jobs and no immutable image IDs; choose a new --out directory")
  }
  if (existingRun.imageId && existingRun.imageId !== imageId) {
    throw new Error(`cannot append after image ${image} changed from ${existingRun.imageId} to ${imageId}`)
  }
  if (existingRun.baseImageId && existingRun.baseImageId !== baseImageId) {
    throw new Error(`cannot append after base image ${baseImage} changed from ${existingRun.baseImageId} to ${baseImageId}`)
  }
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
  if (!canonicalJobArtifacts(jobDir)) {
    return null
  }

  const result = {
    status: "completed",
    error: null,
    timedOut: false,
    artifactsComplete: true,
    model: job.model,
    runner: job.runner || "src",
    provider: job.runner === "aml" ? job.provider || "opencode" : null,
    input: job.input,
    startedAt,
    endedAt: new Date().toISOString(),
    outputBytes: fileSize(join(jobDir, "review.md")),
    files: jobFiles(jobDir, job.runner),
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

function saveReviewCache({ cacheDir, key, jobDir, result, job, reviewerImageId }) {
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
    capture: "review-dry-run",
    status: "completed",
    key,
    model: job.model,
    runner: job.runner || "src",
    provider: job.runner === "aml" ? job.provider || "opencode" : null,
    reviewerImageId,
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

function writeRunFile({ outDir, runConfig, preservedJobs, results, complete = false }) {
  const updatedAt = new Date().toISOString()
  const snapshot = {
    ...runConfig,
    status: complete ? "completed" : "running",
    updatedAt,
    jobs: [...preservedJobs, ...results.filter(Boolean)],
  }
  if (complete) {
    snapshot.endedAt = updatedAt
  }
  writeJson(join(outDir, "run.json"), snapshot)
}

async function runJob(job, options) {
  const jobSlug = evalJobKey(job)
  const jobDir = join(options.outDir, "jobs", jobSlug)
  const reviewFile = join(jobDir, "review.md")
  const transcriptFile = join(jobDir, "review_transcript.md")
  const commentsFile = join(jobDir, "review_comments.json")
  const statsFile = join(jobDir, "review_stats.json")
  const stdoutFile = join(jobDir, "docker.stdout.log")
  const stderrFile = join(jobDir, "docker.stderr.log")
  const artifactDir = join(jobDir, "artifacts")
  const containerName = `singular-eval-${EVAL_OWNER_ID.slice(0, 8)}-${job.index}-${Date.now()}`
  // Keep the live checkout outside the output mount. Otherwise Docker exposes
  // it through both the permitted runtime path and `/eval-output`, which makes
  // OpenCode reject a discovered alias as an external directory.
  const runtimeDir = join(tmpdir(), "singular-code-review-eval", containerName)

  mkdirSync(jobDir, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true })

  const startedAt = new Date().toISOString()
  let preserveScratch = false
  let stagedOpenCodeAuth = []
  console.log(`[${job.index + 1}/${job.total}] ${job.input.ref} ${job.model}`)

  try {
    const loaded = await loadPullRequestInput(job.input, options.githubToken)
    const reviewer = reviewerContainerConfig(job)

    // Inputs belong to the eval boundary, not the reviewer workflow. AML can
    // remain entirely in memory while the judge still receives the exact PR
    // snapshot used to identify and cache this capture.
    writeJson(join(artifactDir, "review_model_context.json"), loaded.context)
    writeText(join(artifactDir, "pr.diff"), loaded.diffText)
    const cacheKey = reviewCacheKey({
      runner: job.runner,
      provider: job.provider,
      model: job.model,
      reviewerImageId: options.imageId,
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
    preserveScratch = options.keepScratch

    if (reviewer.requiresCodexAuth) {
      const sourceHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")
      const sourceAuth = join(sourceHome, "auth.json")
      if (!existsSync(sourceAuth)) {
        throw new Error("Codex ChatGPT authentication is required; run codex login")
      }

      const targetHome = join(runtimeDir, "codex-home")
      const targetAuth = join(targetHome, "auth.json")
      // Codex may refresh ChatGPT credentials during a session. Give it an
      // ephemeral writable copy so the container cannot mutate host auth.
      mkdirSync(targetHome, { recursive: true, mode: 0o700 })
      chmodSync(targetHome, 0o700)
      copyFileSync(sourceAuth, targetAuth)
      chmodSync(targetAuth, 0o600)
    }

    if (reviewer.usesOpenCodeAuth) {
      stagedOpenCodeAuth = stageOpenCodeAuth(join(runtimeDir, "xdg", "data"))
    }

    const missingEnvironment = reviewer.requiredEnvironment.filter(key => !String(process.env[key] || "").trim())
    if (missingEnvironment.length > 0) {
      throw new Error(`missing required reviewer environment: ${missingEnvironment.join(", ")}`)
    }

    const dockerArgs = [
      "run",
      "--rm",
      "--name",
      containerName,
      "--label",
      "singular-code-review-eval=true",
      "--label",
      `${EVAL_OWNER_LABEL}=${EVAL_OWNER_ID}`,
      "--entrypoint",
      "/usr/local/bin/review_dry_run",
      "--env",
      "GH_TOKEN",
      "--env",
      "REVIEW_IGNORE_HISTORY",
      "--env",
      `REVIEW_RUNNER=${reviewer.command}`,
      ...reviewer.inheritedEnvironment.flatMap(key => ["--env", key]),
      ...Object.keys(reviewer.environment).flatMap(key => ["--env", key]),
      "--volume",
      `${jobDir}:/eval-output`,
      "--volume",
      `${runtimeDir}:/tmp/.singular-code-review/eval-runtime`,
      options.image,
      job.input.repository,
      String(job.input.number),
      ...(job.input.baseSha ? ["--base-sha", job.input.baseSha] : []),
      ...(job.input.headSha ? ["--head-sha", job.input.headSha] : []),
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
        ...reviewer.environment,
        REVIEW_IGNORE_HISTORY: job.input.ignoreHistory ? "true" : "false",
      },
      stdoutFile,
      stderrFile,
      timeoutMs: options.reviewTimeoutMs,
    })
    copyRuntimeArtifacts(runtimeDir, artifactDir, job.runner)
    if (run.status === 0 && job.runner === "aml") {
      // AML emits one typed result on stdout. Keep markdown/comments/stats as
      // eval compatibility views, outside the production reviewer image.
      try {
        writeAmlArtifacts(readAmlResult(stdoutFile), jobDir)
      } catch (error) {
        run.status = 1
        run.error = error instanceof Error ? error.message : String(error)
      }
    }
    // review_dry_run maps both implementations into the same extracted
    // comments/stats/transcript contract before the candidate is rendered.
    if (run.status === 0 && existsSync(commentsFile) && existsSync(statsFile) && existsSync(transcriptFile)) {
      writeCandidateReview({ commentsFile, reviewFile })
    }
    const outputBytes = fileSize(reviewFile)
    const captureFailure = readCaptureFailure({ run, commentsFile, artifactDir, runner: job.runner })

    const artifactsComplete = canonicalJobArtifacts(jobDir)
    const completed = !captureFailure && outputBytes > 0 && artifactsComplete
    const result = {
      status: completed ? "completed" : "failed",
      error: completed
        ? null
        : captureFailure || (outputBytes <= 0 ? "dry-run review output was empty" : "canonical review artifacts are incomplete"),
      timedOut: Boolean(run.timedOut),
      artifactsComplete,
      model: job.model,
      runner: job.runner,
      provider: job.runner === "aml" ? job.provider : null,
      input: job.input,
      startedAt,
      endedAt: new Date().toISOString(),
      outputBytes,
      files: jobFiles(jobDir, job.runner),
      scratch: preserveScratch ? runtimeDir : null,
      cache: {
        hit: false,
        key: cacheKey,
        dir: cacheEntryDir(options.cacheDir, cacheKey),
      },
    }
    writeJson(join(jobDir, "result.json"), result)
    saveReviewCache({
      cacheDir: options.cacheDir,
      key: cacheKey,
      jobDir,
      result,
      job,
      reviewerImageId: options.imageId,
    })
    return result
  } catch (error) {
    const result = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      timedOut: false,
      artifactsComplete: false,
      model: job.model,
      runner: job.runner,
      provider: job.runner === "aml" ? job.provider : null,
      input: job.input,
      startedAt,
      endedAt: new Date().toISOString(),
      outputBytes: 0,
      files: jobFiles(jobDir, job.runner),
      scratch: preserveScratch ? runtimeDir : null,
      cache: null,
    }
    writeJson(join(jobDir, "result.json"), result)
    return result
  } finally {
    removeDockerContainer(containerName)
    // A retained Codex workspace must never retain the staged ChatGPT login.
    rmSync(join(runtimeDir, "codex-home"), { recursive: true, force: true })
    // OpenCode auth is equally sensitive when --keep-scratch preserves logs.
    for (const authFile of stagedOpenCodeAuth) {
      rmSync(authFile, { force: true })
    }
    if (!preserveScratch) {
      rmSync(runtimeDir, { recursive: true, force: true })
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const config = await loadEvalConfig(options.configFile)
  const runner = normalizeReviewRunner(options.runner || config.runner)
  if (runner !== "aml" && options.amlProvider !== undefined) {
    throw new Error("--aml-provider requires --runner aml")
  }
  const amlProvider = runner === "aml" ? normalizeAmlReviewProvider(options.amlProvider || config.amlProvider) : undefined
  const models = resolveModels(options, config, runner, amlProvider)
  const inputs = resolveInputs(options, config)
  const concurrency = positiveInteger(options.concurrency, config.concurrency, "concurrency")
  const targetDurationMs = positiveInteger(options.targetDurationMs, config.targetDurationMs, "targetDurationMs")
  const reviewTimeoutMs = positiveInteger(options.reviewTimeoutMs, config.reviewTimeoutMs, "reviewTimeoutMs")
  const keepScratch = options.keepScratch ?? config.keepScratch
  const baseImage = options.baseImage || config.baseImage || DEFAULT_BASE_IMAGE
  const githubToken = await resolveGitHubToken(process.env)
  const runFile = join(options.outDir, "run.json")
  const existingRun = options.append ? readJson(runFile, null) : null
  if (!options.append && existsSync(runFile)) {
    throw new Error(`run already exists at ${options.outDir}; pass --append or choose a new --out directory`)
  }
  const startedAt = existingRun?.startedAt || new Date().toISOString()

  if (existingRun) {
    const requestedIdentity = {
      runner,
      provider: amlProvider || null,
      image: options.image,
      baseImage,
    }
    for (const key of Object.keys(requestedIdentity)) {
      if ((existingRun[key] ?? null) !== requestedIdentity[key]) {
        throw new Error(`cannot append with different ${key}: existing ${existingRun[key] ?? null}, requested ${requestedIdentity[key]}`)
      }
    }
  }

  mkdirSync(options.outDir, { recursive: true })
  startOwnerLease()
  cleanupStaleDockerContainers()
  if (!options.skipBuild) {
    await buildDockerImage({ image: options.image, baseImage })
  }
  const imageId = dockerImageId(options.image)
  const baseImageId = dockerImageId(baseImage)
  validateAppendImageIdentity(existingRun, { image: options.image, imageId, baseImage, baseImageId })
  const runConfig = {
    startedAt,
    configFile: options.configFile,
    models: uniqueStrings([...(existingRun?.models || []), ...models]),
    runner,
    provider: amlProvider || null,
    inputs: mergeInputs(existingRun?.inputs || [], inputs),
    concurrency,
    targetDurationMs,
    reviewTimeoutMs,
    keepScratch,
    cacheDir: options.cacheDir,
    image: options.image,
    imageId,
    baseImage,
    baseImageId,
    skipBuild: options.skipBuild,
  }
  writeJson(join(options.outDir, "run-config.json"), runConfig)

  const existingJobs = existingRun?.jobs || []
  const reusableJobs = options.force
    ? []
    : existingJobs.filter(
        job =>
          job.status === "completed" && completedJobArtifacts(join(options.outDir, "jobs", evalJobKey(job)))
      )
  const requestedJobs = inputs.flatMap(input =>
    models.map(model => ({ input, model, runner, ...(amlProvider ? { provider: amlProvider } : {}) }))
  )
  const duplicateJobs = requestedJobs.filter(requested => reusableJobs.some(existing => sameCaptureJob(existing, requested)))
  const jobs = requestedJobs.filter(requested => !reusableJobs.some(existing => sameCaptureJob(existing, requested)))
  const rerunJobKeys = new Set(jobs.map(evalJobKey))
  const preservedJobs = existingJobs.filter((job) => !rerunJobKeys.has(evalJobKey(job)))
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
        keepScratch,
        force: options.force,
        cacheDir: options.cacheDir,
        image: options.image,
        imageId,
      })
      completedResults.push(result)
      writeRunFile({ outDir: options.outDir, runConfig, preservedJobs, results: completedResults })
      return result
    },
  )

  writeRunFile({ outDir: options.outDir, runConfig, preservedJobs, results, complete: true })

  const completed = results.filter((result) => result.status === "completed").length
  console.log(`captured ${completed}/${results.length} new reviews`)
  console.log(`run: ${options.outDir}`)
}

export { isOrphanedEvalContainer, runProcess, sameCaptureJob, validateAppendImageIdentity, writeRunFile }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}
