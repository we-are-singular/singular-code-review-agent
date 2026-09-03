import { spawnSync } from "node:child_process"

import type { ReviewSnapshot } from "../types/review.js"
import { ReviewDiff } from "./review-diff.js"

export type GateDecision =
  | { decision: "review"; reason: string }
  | { decision: "no-review"; answer: string }
  | { decision: "answer"; answer: string }

export type GateDeltaMode =
  | "no_previous_review"
  | "same_head"
  | "ancestor_diff"
  | "rebase_compare"
  | "current_pr_diff"
  | "unavailable"

type GateDelta = {
  mode: GateDeltaMode
  summary: string
  lastReviewedCommit: string | null
  currentHead: string | null
  changedFiles: string[]
  oldPatchId: string | null
  currentPatchId: string | null
  patchIdsMatch: boolean | null
  text: string
}

type BotReview = {
  id: number | null
  state: string | null
  body: string
  submittedAt: string | null
  commitId: string
}

export type GateContext = {
  trigger: ReviewSnapshot["trigger"]
  pullRequest: {
    number: number
    title: string | null
    author: string | null
    baseRef: string | null
    headRef: string | null
  }
  participants: string[]
  actionItems: ReviewSnapshot["actionItems"]
  previousBotFindings: Array<{
    id: number
    url: string | null
    path: string | null
    line: number | null
    body: string
  }>
  unresolvedBotThreads: Array<{
    id: string | null
    path: string | null
    line: number | null
    latestAuthor: string | null
    latestBody: string
  }>
  lastBotReview: BotReview | null
  delta: Omit<GateDelta, "text">
}

export type GatePreparation =
  | { action: "review"; reason: string }
  | { action: "post"; decision: Extract<GateDecision, { decision: "answer" | "no-review" }> }
  | { action: "agent"; context: GateContext; deltaText: string }

// The gate is a fast classifier, not a second reviewer. Oversized evidence is
// escalated to the full lane tree instead of spending a long turn here.
const MAX_GATE_EVIDENCE_CHARS = 80_000

/** Reconstructs only the commits added since the last completed bot review. */
class ReviewDelta {
  readonly #workspace: string

  constructor(workspace: string) {
    this.#workspace = workspace
  }

  build(snapshot: ReviewSnapshot, lastReview: BotReview | null): GateDelta {
    const currentHead = this.#commit(snapshot.pullRequest.headRefOid || "HEAD")
    const lastReviewedCommit = this.#commit(lastReview?.commitId || null)

    if (!lastReview || !lastReviewedCommit) {
      return this.#result(
        "no_previous_review",
        "No previous completed bot review with a commit anchor was found.",
        null,
        currentHead
      )
    }
    if (!currentHead) {
      return this.#result("unavailable", "Could not resolve the current head commit.", lastReviewedCommit, null)
    }
    if (lastReviewedCommit === currentHead) {
      return {
        ...this.#result("same_head", "Current head matches the last reviewed commit.", lastReviewedCommit, currentHead),
        patchIdsMatch: true
      }
    }

    const ancestor = this.#run(["merge-base", "--is-ancestor", lastReviewedCommit, currentHead]).status === 0
    return ancestor
      ? this.#ancestor(lastReviewedCommit, currentHead)
      : this.#rebase(snapshot.pullRequest.baseRefOid || null, lastReviewedCommit, currentHead)
  }

  /** Uses a normal commit range when the reviewed commit remains in history. */
  #ancestor(lastReviewedCommit: string, currentHead: string): GateDelta {
    const range = `${lastReviewedCommit}..${currentHead}`
    const raw = this.#text(["diff", "--find-renames", range])
    if (raw === null) {
      return this.#result(
        "unavailable",
        "Could not reconstruct the commit delta from the last review.",
        lastReviewedCommit,
        currentHead
      )
    }
    const diff = ReviewDiff.from(raw)
    return {
      mode: "ancestor_diff",
      summary: `Delta from last reviewed commit ${lastReviewedCommit} to current head ${currentHead}.`,
      lastReviewedCommit,
      currentHead,
      changedFiles: this.#changedFiles(range),
      oldPatchId: null,
      currentPatchId: this.#patchId(diff.text),
      patchIdsMatch: null,
      text: diff.text
    }
  }

  /** Compares patch ranges after a force-push or rebase changed commit ancestry. */
  #rebase(base: string | null, lastReviewedCommit: string, currentHead: string): GateDelta {
    const verifiedBase = this.#commit(base)
    const oldBase = verifiedBase ? this.#text(["merge-base", lastReviewedCommit, verifiedBase]) : null
    const currentBase = verifiedBase ? this.#text(["merge-base", currentHead, verifiedBase]) : null
    if (!oldBase || !currentBase) {
      return this.#result(
        "unavailable",
        "Could not reconstruct patch ranges after the pull request history changed.",
        lastReviewedCommit,
        currentHead
      )
    }

    const oldRange = `${oldBase}..${lastReviewedCommit}`
    const currentRange = `${currentBase}..${currentHead}`
    const oldPatch = this.#text(["diff", "--find-renames", oldRange])
    const currentPatch = this.#text(["diff", "--find-renames", currentRange])
    if (oldPatch === null || currentPatch === null) {
      return this.#result(
        "unavailable",
        "Could not compare the old and current pull request patches.",
        lastReviewedCommit,
        currentHead
      )
    }

    const oldPatchId = this.#patchId(ReviewDiff.from(oldPatch).text)
    const currentPatchId = this.#patchId(ReviewDiff.from(currentPatch).text)
    const patchIdsMatch = Boolean(oldPatchId && currentPatchId && oldPatchId === currentPatchId)
    const rangeDiff = this.#text(["range-diff", oldRange, currentRange]) || "(range-diff unavailable or empty)"
    return {
      mode: "rebase_compare",
      summary: "Commit ancestry changed; comparing the previous and current pull request patch ranges.",
      lastReviewedCommit,
      currentHead,
      changedFiles: this.#changedFiles(currentRange),
      oldPatchId,
      currentPatchId,
      patchIdsMatch: oldPatchId && currentPatchId ? oldPatchId === currentPatchId : null,
      text: [
        "Delta mode: rebase_compare",
        `Last reviewed range: ${oldRange}`,
        `Current range: ${currentRange}`,
        `Patch ids match: ${patchIdsMatch ? "yes" : "no"}`,
        "",
        "range-diff:",
        rangeDiff,
        ""
      ].join("\n")
    }
  }

  #result(
    mode: GateDeltaMode,
    summary: string,
    lastReviewedCommit: string | null,
    currentHead: string | null
  ): GateDelta {
    return {
      mode,
      summary,
      lastReviewedCommit,
      currentHead,
      changedFiles: [],
      oldPatchId: null,
      currentPatchId: null,
      patchIdsMatch: null,
      text: `${summary}\n`
    }
  }

  #changedFiles(range: string): string[] {
    return (this.#text(["diff", "--name-only", range]) || "").split(/\r?\n/u).filter(Boolean)
  }

  #patchId(patch: string): string | null {
    if (!patch.trim()) {
      return null
    }
    return this.#text(["patch-id", "--stable"], patch)?.split(/\s+/u)[0] || null
  }

  #commit(commit: string | null): string | null {
    return commit ? this.#text(["rev-parse", "--verify", `${commit}^{commit}`]) : null
  }

  #text(args: string[], input?: string): string | null {
    const result = this.#run(args, input)
    return result.status === 0 ? result.stdout.trimEnd() : null
  }

  #run(args: string[], input?: string) {
    return spawnSync("git", args, {
      cwd: this.#workspace,
      encoding: "utf8",
      input,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"]
    })
  }
}

/** An explicit re-review request bypasses the cheap classifier. */
function requestsFullReview(snapshot: ReviewSnapshot): boolean {
  if (snapshot.trigger.reason !== "mention" || !snapshot.trigger.comment) {
    return false
  }
  const text = snapshot.trigger.comment.body.toLowerCase().replace(/\s+/gu, " ").trim()
  return (
    /\bre-?review\b/u.test(text) ||
    /\breview\s+(?:it\s+|this\s+|the\s+pr\s+)?again\b/u.test(text) ||
    /\b(?:please|pls|can you|could you|would you)\b.{0,80}\b(?:full\s+review|(?:try|run)\s+(?:it\s+|this\s+)?again)\b/u.test(
      text
    )
  )
}

function latestBotReview(snapshot: ReviewSnapshot): BotReview | null {
  const review = snapshot.reviews
    .filter(
      candidate => candidate.user?.login === snapshot.botLogin && Boolean(candidate.commit_id || candidate.commitId)
    )
    .at(-1)
  const commitId = review?.commit_id || review?.commitId
  return review && commitId
    ? {
        id: review.id || null,
        state: review.state || null,
        body: review.body || "",
        submittedAt: review.submitted_at || review.submittedAt || null,
        commitId
      }
    : null
}

/** Builds only the history needed by the routing Agent; full evidence lives in files. */
function gateContext(snapshot: ReviewSnapshot, lastBotReview: BotReview | null, delta: GateDelta): GateContext {
  const pullRequestUrl = snapshot.pullRequest.html_url || snapshot.pullRequest.url || null

  return {
    trigger: snapshot.trigger,
    pullRequest: {
      number: snapshot.pullRequest.number,
      title: snapshot.pullRequest.title || null,
      author: snapshot.pullRequest.author?.login || snapshot.pullRequest.user?.login || null,
      baseRef: snapshot.pullRequest.baseRefName || null,
      headRef: snapshot.pullRequest.headRefName || null
    },
    participants: snapshot.participants,
    actionItems: snapshot.actionItems,
    previousBotFindings: snapshot.previousBotFindings.map(finding => ({
      id: finding.id,
      url: finding.html_url || (pullRequestUrl ? `${pullRequestUrl}#discussion_r${finding.id}` : null),
      path: finding.path || null,
      line: finding.line || null,
      body: finding.body || ""
    })),
    unresolvedBotThreads: snapshot.unresolvedBotThreads.map(thread => ({
      id: thread.id,
      path: thread.path,
      line: thread.line,
      latestAuthor: thread.latest_author,
      latestBody: thread.comments.at(-1)?.body || ""
    })),
    lastBotReview,
    delta: {
      mode: delta.mode,
      summary: delta.summary,
      lastReviewedCommit: delta.lastReviewedCommit,
      currentHead: delta.currentHead,
      changedFiles: delta.changedFiles,
      oldPatchId: delta.oldPatchId,
      currentPatchId: delta.currentPatchId,
      patchIdsMatch: delta.patchIdsMatch
    }
  }
}

/** Applies cheap invariants before asking the routing Agent about a follow-up. */
export function prepareGate(snapshot: ReviewSnapshot, workspace: string): GatePreparation {
  const reason = snapshot.trigger.reason
  if (reason !== "synchronize" && reason !== "mention") {
    return { action: "review", reason: `gate is not used for ${reason} triggers` }
  }
  if (requestsFullReview(snapshot)) {
    return { action: "review", reason: "mention explicitly requested a full review" }
  }

  const lastReview = latestBotReview(snapshot)
  let delta = new ReviewDelta(workspace).build(snapshot, lastReview)
  if (reason === "synchronize" && delta.mode === "no_previous_review") {
    return { action: "review", reason: "no previous bot review" }
  }
  if (reason === "synchronize" && delta.mode === "same_head") {
    return {
      action: "post",
      decision: {
        decision: "no-review",
        answer: "No full re-review needed: the current head commit already has a completed Singular Code Review."
      }
    }
  }
  if (reason === "synchronize" && delta.mode === "unavailable") {
    return { action: "review", reason: delta.summary }
  }

  if (delta.text.length > MAX_GATE_EVIDENCE_CHARS) {
    if (snapshot.diff.text.length <= MAX_GATE_EVIDENCE_CHARS) {
      delta = {
        mode: "current_pr_diff",
        summary: "The historical delta was too large; using the current filtered pull request diff.",
        lastReviewedCommit: delta.lastReviewedCommit,
        currentHead: delta.currentHead,
        changedFiles: snapshot.diff.files.map(file => file.path),
        oldPatchId: null,
        currentPatchId: null,
        patchIdsMatch: null,
        text: snapshot.diff.text
      }
    } else if (reason === "synchronize") {
      return { action: "review", reason: "delta is too large for the gate" }
    } else {
      delta = {
        ...delta,
        mode: "unavailable",
        summary: "Delta is too large for the gate context.",
        text: "Delta is too large for a cheap routing decision. Choose review if the request depends on code changes.\n"
      }
    }
  }

  return { action: "agent", context: gateContext(snapshot, lastReview, delta), deltaText: delta.text }
}
