import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"

import { estimateCostUsd } from "./review-pricing.js"
import type { ReviewUsage } from "./review-telemetry.js"

const counter = z.number().int().nonnegative()
// Reject schema drift or malformed samples instead of silently pricing a subtotal.
const storedTokens = z.object({
  input: counter,
  output: counter,
  reasoning: counter,
  cache: z.object({ read: counter, write: counter }),
  total: counter.optional()
})

/**
 * Temporary stock-OpenCode accounting override; owns only this review's retained databases.
 * Remove after verifying upstream ACP usage against the offline probe (OpenCode #41660).
 */
export class OpenCodeUsage {
  readonly directory: string | undefined
  #collected = false
  #override: Omit<ReviewUsage, "agentCalls"> | undefined
  #note = "OpenCode database usage unavailable; using AML counters, which may omit intermediate model calls."

  constructor() {
    try {
      this.directory = mkdtempSync(join(tmpdir(), "review-opencode-usage-"))
    } catch {
      // Optional accounting must not prevent a review from starting.
    }
  }

  /** Reads each completed model step once, after all Agents have settled. Never combines a partial DB read with ACP totals. */
  collect(expectedSessions: readonly string[]): void {
    if (this.#collected) return
    this.#collected = true
    if (!this.directory || expectedSessions.length === 0) return

    try {
      const totals = {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0
      }
      const sessions = new Set<string>()
      let steps = 0
      let estimatedCostUsd: number | null = 0

      // Scan only the directory created for this review, not the user's OpenCode history.
      for (const file of readdirSync(this.directory, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.startsWith("aml-acp-") || !file.name.endsWith(".db")) continue
        const db = new DatabaseSync(join(this.directory, file.name), { readOnly: true })
        try {
          // Message totals duplicate step totals (and can retain only the last step).
          // Read step-finish parts only; model identity belongs to their assistant message.
          const rows = db
            .prepare(`
            SELECT p.session_id AS sessionId,
              json_extract(m.data, '$.providerID') AS provider,
              json_extract(m.data, '$.modelID') AS model,
              json_extract(p.data, '$.tokens') AS tokens
            FROM part p LEFT JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
            WHERE json_extract(p.data, '$.type') = 'step-finish'
          `)
            .all()
          for (const row of rows) {
            if (
              typeof row.sessionId !== "string" ||
              typeof row.provider !== "string" ||
              typeof row.model !== "string" ||
              typeof row.tokens !== "string"
            ) {
              throw new Error("Unrecognized OpenCode usage record")
            }
            const tokens = storedTokens.parse(JSON.parse(row.tokens))
            sessions.add(row.sessionId)
            steps += 1
            totals.inputTokens += tokens.input
            totals.outputTokens += tokens.output
            totals.reasoningTokens += tokens.reasoning
            totals.cacheReadTokens += tokens.cache.read
            totals.cacheWriteTokens += tokens.cache.write
            totals.totalTokens +=
              tokens.total ?? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write

            if (estimatedCostUsd !== null) {
              const cost = estimateCostUsd(`${row.provider}/${row.model}`, {
                inputTokens: tokens.input,
                outputTokens: tokens.output,
                reasoningTokens: tokens.reasoning,
                cacheReadTokens: tokens.cache.read,
                cacheWriteTokens: tokens.cache.write
              })
              estimatedCostUsd = cost === null ? null : estimatedCostUsd + cost
            }
          }
        } finally {
          db.close()
        }
      }

      // A missing Agent database must not silently replace a whole-review fallback with a subtotal.
      if (!expectedSessions.every(session => sessions.has(session))) throw new Error("Missing OpenCode session usage")
      this.#override = { ...totals, costUsd: null, estimatedCostUsd }
      this.#note = `Temporary OpenCode database override: ${steps} stored model steps; AML counters retained separately. Requests without recorded usage remain uncounted. Costs are fixed-rate estimates, not a reconciled Go bill.`
    } catch {
      this.#note =
        "OpenCode database collection failed or was incomplete; using AML counters, which may omit intermediate model calls."
    }
  }

  /** Removes retained transcripts after collection; cleanup failure never changes publication outcome. */
  close(): void {
    if (!this.directory) return
    try {
      rmSync(this.directory, { recursive: true, force: true })
    } catch {
      this.#note += ` Temporary database cleanup failed at ${this.directory}.`
    }
  }

  /** Applies the temporary override without losing the original AML accounting or authored turn count. */
  apply(amlUsage: ReviewUsage): {
    usage: ReviewUsage
    amlUsage: ReviewUsage
    usageSource: "opencode-db" | "aml-acp"
    usageNote: string
  } {
    return {
      // ACP may cover only the final request. Keep its costs as raw evidence,
      // never as the review cost, even when database collection falls back.
      usage: { ...amlUsage, costUsd: null, estimatedCostUsd: null, ...this.#override },
      amlUsage,
      usageSource: this.#override ? "opencode-db" : "aml-acp",
      usageNote: this.#note
    }
  }
}
