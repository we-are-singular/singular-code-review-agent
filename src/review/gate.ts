import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { buildReviewerContext } from "./context.js"
import { type GateContext, type GateDecision, type GateDeltaMode, type ReviewContext } from "./types.js"

const MAX_GATE_DELTA_CHARS = 80_000

type GateDelta = GateContext["delta"] & {
  text: string
}

export type GatePreparation =
  | {
      action: "run-review"
      reason: string
    }
  | {
      action: "post"
      decision: Extract<GateDecision, { decision: "answer" | "no-review" }>
      context: GateContext
      deltaText: string
    }
  | {
      action: "run-gate"
      context: GateContext
      deltaText: string
    }

type GitResult = {
  ok: boolean
  status: number | null
  stdout: string
  stderr: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  return (
    actual.length === keys.length &&
    keys
      .slice()
      .sort()
      .every((key, index) => actual[index] === key)
  )
}

function git(workspace: string, args: string[], input?: string): GitResult {
  const result = spawnSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    input,
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"]
  })

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  }
}

function gitText(workspace: string, args: string[], input?: string): string | null {
  const result = git(workspace, args, input)
  return result.ok ? result.stdout.trimEnd() : null
}

function verifyCommit(workspace: string, commit: string | null): string | null {
  if (!commit) {
    return null
  }
  return gitText(workspace, ["rev-parse", "--verify", `${commit}^{commit}`])
}

function currentHead(context: ReviewContext, workspace: string): string | null {
  const pr = asRecord(context.pr)
  const head = asRecord(pr.head)
  return stringValue(pr.headRefOid) || stringValue(head.sha) || verifyCommit(workspace, "HEAD")
}

function currentBase(context: ReviewContext): string | null {
  const pr = asRecord(context.pr)
  const base = asRecord(pr.base)
  return stringValue(pr.baseRefOid) || stringValue(base.sha)
}

function latestBotReview(context: ReviewContext, botLogin: string): GateContext["last_bot_review"] {
  const reviewerContext = buildReviewerContext(context)
  const botReviews = reviewerContext.recent_reviews.filter(
    review => review.user_login === botLogin && Boolean(review.commit_id)
  )
  return botReviews[botReviews.length - 1] || null
}

function mentionRequestsFullReview(context: ReviewContext): boolean {
  if (context.run.reason !== "mention" || !context.run.trigger_comment) {
    return false
  }

  const text = context.run.trigger_comment.body.toLowerCase().replace(/\s+/gu, " ").trim()
  return (
    /\bre-?review\b/u.test(text) ||
    /\breview\s+(?:it\s+|this\s+|the\s+pr\s+)?again\b/u.test(text) ||
    /\b(?:please|pls|can you|could you|would you)\b.{0,80}\b(?:full\s+review|(?:try|run)\s+(?:it\s+|this\s+)?again)\b/u.test(
      text
    )
  )
}

function diffHash(text: string): string | null {
  return text ? createHash("sha256").update(text).digest("hex") : null
}

function changedFiles(workspace: string, range: string): string[] {
  const output = gitText(workspace, ["diff", "--name-only", range])
  return output ? output.split(/\r?\n/u).filter(Boolean) : []
}

function patchId(workspace: string, patch: string): string | null {
  if (!patch.trim()) {
    return null
  }
  const output = gitText(workspace, ["patch-id", "--stable"], patch)
  return output?.split(/\s+/u)[0] || null
}

function ancestorDelta(workspace: string, lastCommit: string, headCommit: string): GateDelta | null {
  const range = `${lastCommit}..${headCommit}`
  const text = gitText(workspace, ["diff", "--find-renames", range])
  if (text === null) {
    return null
  }

  return {
    mode: "ancestor_diff",
    file: null,
    summary: `Delta from last reviewed commit ${lastCommit} to current head ${headCommit}.`,
    last_reviewed_commit: lastCommit,
    current_head: headCommit,
    changed_files: changedFiles(workspace, range),
    old_patch_id: null,
    current_patch_id: patchId(workspace, text),
    patch_ids_match: null,
    text
  }
}

function rebaseDelta(
  workspace: string,
  baseCommit: string | null,
  lastCommit: string,
  headCommit: string
): GateDelta | null {
  const verifiedBase = verifyCommit(workspace, baseCommit)
  if (!verifiedBase) {
    return null
  }

  const oldBase = gitText(workspace, ["merge-base", lastCommit, verifiedBase])
  const currentBase = gitText(workspace, ["merge-base", headCommit, verifiedBase])
  if (!oldBase || !currentBase) {
    return null
  }

  const oldRange = `${oldBase}..${lastCommit}`
  const currentRange = `${currentBase}..${headCommit}`
  const oldPatch = gitText(workspace, ["diff", "--find-renames", oldRange])
  const currentPatch = gitText(workspace, ["diff", "--find-renames", currentRange])
  if (oldPatch === null || currentPatch === null) {
    return null
  }

  const oldPatchId = patchId(workspace, oldPatch)
  const currentPatchId = patchId(workspace, currentPatch)
  const rangeDiff = gitText(workspace, ["range-diff", oldRange, currentRange]) || ""
  const patchIdsMatch = Boolean(oldPatchId && currentPatchId && oldPatchId === currentPatchId)
  const header = [
    "Delta mode: rebase_compare",
    `Last reviewed range: ${oldRange}`,
    `Current range: ${currentRange}`,
    `Patch ids match: ${patchIdsMatch ? "yes" : "no"}`,
    "",
    "range-diff:"
  ].join("\n")

  return {
    mode: "rebase_compare",
    file: null,
    summary: "Last reviewed commit is not an ancestor of current head; comparing old and current PR patch ranges.",
    last_reviewed_commit: lastCommit,
    current_head: headCommit,
    changed_files: changedFiles(workspace, currentRange),
    old_patch_id: oldPatchId,
    current_patch_id: currentPatchId,
    patch_ids_match: oldPatchId && currentPatchId ? oldPatchId === currentPatchId : null,
    text: `${header}\n${rangeDiff || "(range-diff unavailable or empty)"}\n`
  }
}

function buildDelta(options: {
  context: ReviewContext
  workspace: string
  lastReview: GateContext["last_bot_review"]
}): GateDelta {
  const headCommit = verifyCommit(options.workspace, currentHead(options.context, options.workspace))
  const lastCommit = verifyCommit(options.workspace, options.lastReview?.commit_id || null)

  if (!options.lastReview || !lastCommit) {
    return {
      mode: "no_previous_review",
      file: null,
      summary: "No previous completed bot review with a commit anchor was found.",
      last_reviewed_commit: null,
      current_head: headCommit,
      changed_files: [],
      old_patch_id: null,
      current_patch_id: null,
      patch_ids_match: null,
      text: "No previous completed bot review with a commit anchor was found.\n"
    }
  }

  if (!headCommit) {
    return {
      mode: "unavailable",
      file: null,
      summary: "Could not resolve current head commit.",
      last_reviewed_commit: lastCommit,
      current_head: null,
      changed_files: [],
      old_patch_id: null,
      current_patch_id: null,
      patch_ids_match: null,
      text: "Could not resolve current head commit.\n"
    }
  }

  if (lastCommit === headCommit) {
    return {
      mode: "same_head",
      file: null,
      summary: "Current head matches the last reviewed commit.",
      last_reviewed_commit: lastCommit,
      current_head: headCommit,
      changed_files: [],
      old_patch_id: null,
      current_patch_id: null,
      patch_ids_match: true,
      text: "Current head matches the last completed Singular Code Review commit.\n"
    }
  }

  const ancestor = git(options.workspace, ["merge-base", "--is-ancestor", lastCommit, headCommit])
  const delta = ancestor.ok
    ? ancestorDelta(options.workspace, lastCommit, headCommit)
    : rebaseDelta(options.workspace, currentBase(options.context), lastCommit, headCommit)

  if (!delta) {
    return {
      mode: "unavailable",
      file: null,
      summary: "Could not reconstruct a safe delta from the last bot review to current head.",
      last_reviewed_commit: lastCommit,
      current_head: headCommit,
      changed_files: [],
      old_patch_id: null,
      current_patch_id: null,
      patch_ids_match: null,
      text: "Could not reconstruct a safe delta from the last bot review to current head.\n"
    }
  }

  return delta
}

export function buildGateContext(options: {
  context: ReviewContext
  delta: GateDelta
  diffText: string
  botLogin: string
}): GateContext {
  const reviewerContext = buildReviewerContext(options.context)
  const recentBotReviews = reviewerContext.recent_reviews.filter(review => review.user_login === options.botLogin)

  return {
    generated_at: reviewerContext.generated_at,
    run: reviewerContext.run,
    pr: reviewerContext.pr,
    diff: {
      files: reviewerContext.diff.files,
      ignored: reviewerContext.diff.ignored,
      current_hash: diffHash(options.diffText)
    },
    issue_comments: reviewerContext.issue_comments,
    recent_bot_reviews: recentBotReviews,
    last_bot_review: recentBotReviews.find(review => review.commit_id === options.delta.last_reviewed_commit) || null,
    previous_bot_findings: reviewerContext.previous_bot_findings,
    unresolved_bot_threads: reviewerContext.unresolved_bot_threads,
    action_items: reviewerContext.action_items,
    delta: {
      mode: options.delta.mode,
      file: options.delta.file,
      summary: options.delta.summary,
      last_reviewed_commit: options.delta.last_reviewed_commit,
      current_head: options.delta.current_head,
      changed_files: options.delta.changed_files,
      old_patch_id: options.delta.old_patch_id,
      current_patch_id: options.delta.current_patch_id,
      patch_ids_match: options.delta.patch_ids_match
    }
  }
}

export function prepareGate(options: {
  context: ReviewContext
  workspace: string
  diffText: string
  botLogin: string
}): GatePreparation {
  const reason = options.context.run.reason
  if (reason !== "synchronize" && reason !== "mention") {
    return { action: "run-review", reason: `gate is not used for ${reason} triggers` }
  }

  if (mentionRequestsFullReview(options.context)) {
    return { action: "run-review", reason: "mention explicitly requested a full review" }
  }

  const lastReview = latestBotReview(options.context, options.botLogin)
  const delta = buildDelta({ context: options.context, workspace: options.workspace, lastReview })
  const context = buildGateContext({
    context: options.context,
    delta,
    diffText: options.diffText,
    botLogin: options.botLogin
  })

  if (reason === "synchronize" && delta.mode === "no_previous_review") {
    return { action: "run-review", reason: "no previous bot review" }
  }

  if (reason === "synchronize" && delta.mode === "same_head") {
    return {
      action: "post",
      context,
      deltaText: delta.text,
      decision: {
        decision: "no-review",
        answer: "No full re-review needed: the current head commit already has a completed Singular Code Review."
      }
    }
  }

  if (reason === "synchronize" && delta.mode === "unavailable") {
    return { action: "run-review", reason: delta.summary }
  }

  if (delta.text.length > MAX_GATE_DELTA_CHARS) {
    if (reason === "synchronize") {
      return { action: "run-review", reason: "delta is too large for the gate" }
    }
    const largeDelta = {
      ...delta,
      mode: "unavailable" as GateDeltaMode,
      summary: "Delta is too large for the gate context.",
      text: "Delta is too large for the gate context. Choose review if the user asks for review.\n"
    }
    return {
      action: "run-gate",
      context: buildGateContext({
        context: options.context,
        delta: largeDelta,
        diffText: options.diffText,
        botLogin: options.botLogin
      }),
      deltaText: largeDelta.text
    }
  }

  return {
    action: "run-gate",
    context,
    deltaText: delta.text
  }
}

export function parseGateDecision(text: string): GateDecision {
  const trimmed = text.trim()
  const parsed = JSON.parse(trimmed) as unknown
  const record = asRecord(parsed)
  const decision = record.decision

  if (decision === "review") {
    if (!exactKeys(record, ["decision", "reason"]) || !stringValue(record.reason)) {
      throw new Error("gate review decision must include only decision and reason")
    }
    return { decision, reason: String(record.reason) }
  }

  if (decision === "no-review" || decision === "answer") {
    if (!exactKeys(record, ["answer", "decision"]) || !stringValue(record.answer)) {
      throw new Error(`gate ${decision} decision must include only decision and answer`)
    }
    return { decision, answer: String(record.answer) }
  }

  throw new Error("gate decision must be review, no-review, or answer")
}
