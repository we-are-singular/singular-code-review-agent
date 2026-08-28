import { createHash } from "node:crypto"

import type { ReviewPayload } from "../../src/review/types.js"
import type { AmlGitHubClient } from "./github-client.js"

export type GitHubActionMode = "dry-run" | "live"
export type PublicationState = "completed" | "ambiguous" | "pending"
export type PublicationExpectation = { kind: "issue-comment" } | { kind: "review"; replies: number }

export type GitHubActionReceipt = {
  key: string
  kind: "reaction" | "issue-comment" | "review" | "reply"
  status: "prepared" | "submitted" | "skipped" | "failed"
  payload: unknown
  error?: string
}

export type GitHubActions = {
  readonly mode: GitHubActionMode
  reactToIssueComment(commentId: number): Promise<GitHubActionReceipt>
  postIssueComment(prNumber: number, body: string): Promise<GitHubActionReceipt>
  submitPullRequestReview(prNumber: number, payload: ReviewPayload): Promise<GitHubActionReceipt>
  replyToReviewComment(prNumber: number, commentId: number, body: string): Promise<GitHubActionReceipt>
  publicationState(expectation: PublicationExpectation): PublicationState
  receipts(): GitHubActionReceipt[]
}

type ActionKind = GitHubActionReceipt["kind"]

/** Owns request-local idempotency across publication retries and partial failures. */
class ActionLedger {
  readonly #scope: string
  readonly #inFlight = new Map<string, Promise<GitHubActionReceipt>>()
  readonly #receipts = new Map<string, GitHubActionReceipt>()

  constructor(scope: string) {
    this.#scope = scope
  }

  async execute(
    kind: ActionKind,
    payload: unknown,
    mode: GitHubActionMode,
    operation: () => Promise<void>
  ): Promise<GitHubActionReceipt> {
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex")
    const key = `${this.#scope}:${kind}:${digest}`
    const inFlight = this.#inFlight.get(key)
    if (inFlight) {
      return inFlight
    }
    const previous = this.#receipts.get(key)
    if (previous?.status === "prepared" || previous?.status === "submitted") {
      return { ...previous, status: "skipped" }
    }
    if (previous?.status === "failed") {
      // A rejected POST may still have reached GitHub. Replaying it could
      // duplicate a review or comment, so recovery requires reconciliation.
      throw new Error(`refusing to replay ambiguous ${kind} mutation: ${previous.error || "unknown failure"}`)
    }

    // Start the mutation in a microtask after registering its promise, so
    // concurrent duplicate Tool calls coalesce before GitHub is invoked.
    const execution = Promise.resolve().then(async () => {
      try {
        if (mode === "live") {
          await operation()
        }
        const receipt: GitHubActionReceipt = {
          key,
          kind,
          status: mode === "live" ? "submitted" : "prepared",
          payload
        }
        this.#receipts.set(key, receipt)
        return receipt
      } catch (error) {
        const receipt: GitHubActionReceipt = {
          key,
          kind,
          status: "failed",
          payload,
          error: error instanceof Error ? error.message : String(error)
        }
        this.#receipts.set(key, receipt)
        throw error
      }
    })
    this.#inFlight.set(key, execution)
    const clear = () => {
      if (this.#inFlight.get(key) === execution) {
        this.#inFlight.delete(key)
      }
    }
    void execution.then(clear, clear)
    return execution
  }

  values(): GitHubActionReceipt[] {
    return Array.from(this.#receipts.values(), receipt => structuredClone(receipt))
  }
}

/**
 * GitHub mutation port shared by live and dry-run execution. Dry runs exercise
 * the exact payloads and idempotency keys without invoking the delegate.
 */
export class ReviewGitHubActions implements GitHubActions {
  readonly mode: GitHubActionMode
  readonly #github: AmlGitHubClient
  readonly #headSha: string | null
  readonly #ledger: ActionLedger

  constructor(options: {
    mode: GitHubActionMode
    github: AmlGitHubClient
    repository: string
    prNumber: number
    headSha: string | null
  }) {
    this.mode = options.mode
    this.#github = options.github
    this.#headSha = options.headSha
    this.#ledger = new ActionLedger(`${options.repository}#${options.prNumber}@${options.headSha || "unknown-head"}`)
  }

  reactToIssueComment(commentId: number): Promise<GitHubActionReceipt> {
    const payload = { commentId, content: "eyes" as const }
    return this.#ledger.execute("reaction", payload, this.mode, () =>
      this.#github.createIssueCommentReaction(commentId, "eyes")
    )
  }

  postIssueComment(prNumber: number, body: string): Promise<GitHubActionReceipt> {
    const payload = { prNumber, body }
    return this.#ledger.execute("issue-comment", payload, this.mode, () =>
      this.#github.createIssueComment(prNumber, body)
    )
  }

  submitPullRequestReview(prNumber: number, payload: ReviewPayload): Promise<GitHubActionReceipt> {
    const action = { prNumber, headSha: this.#headSha, payload }
    return this.#ledger.execute("review", action, this.mode, async () => {
      if (!this.#headSha) {
        throw new Error("cannot publish a pull request review without its inspected head SHA")
      }
      await this.#github.submitReviewAtHead(prNumber, this.#headSha, payload)
    })
  }

  replyToReviewComment(prNumber: number, commentId: number, body: string): Promise<GitHubActionReceipt> {
    const payload = { prNumber, commentId, body }
    return this.#ledger.execute("reply", payload, this.mode, () => this.#github.submitReply(prNumber, commentId, body))
  }

  /** Interprets the ledger without replaying a rejected GitHub mutation. */
  publicationState(expectation: PublicationExpectation): PublicationState {
    const expectedKinds: ActionKind[] = expectation.kind === "issue-comment" ? ["issue-comment"] : ["review", "reply"]
    const relevant = this.#ledger.values().filter(receipt => expectedKinds.includes(receipt.kind))
    if (relevant.some(receipt => receipt.status === "failed")) {
      return "ambiguous"
    }

    const completed = relevant.filter(receipt => receipt.status === "prepared" || receipt.status === "submitted")
    if (expectation.kind === "issue-comment") {
      return completed.some(receipt => receipt.kind === "issue-comment") ? "completed" : "pending"
    }

    const reviews = completed.filter(receipt => receipt.kind === "review").length
    const replies = completed.filter(receipt => receipt.kind === "reply").length
    return reviews === 1 && replies === expectation.replies ? "completed" : "pending"
  }

  receipts(): GitHubActionReceipt[] {
    return this.#ledger.values()
  }
}
