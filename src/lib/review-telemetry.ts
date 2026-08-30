import { createTraceSummaryCollector, type AmlTraceEvent, type TraceSink, type TraceSummary } from "@aml-jsx/sdk"

export type ReviewUsage = {
  agentCalls: number
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  totalTokens: number | null
  costUsd: number | null
}

export type ReviewProviderCompletion = {
  runId: string
  sessionId: string
  stopReason: string
}

/** Collects content-free AML summaries and provider-optional usage per evaluation. */
export class ReviewTelemetryCollector {
  readonly #collector = createTraceSummaryCollector()
  readonly #completed: TraceSummary[] = []
  readonly #providerCompletions: ReviewProviderCompletion[] = []

  readonly trace: TraceSink

  constructor() {
    const sink = ((event: AmlTraceEvent) => this.#record(event)) as TraceSink
    Object.defineProperty(sink, "captureContent", {
      configurable: false,
      enumerable: true,
      value: false,
      writable: false
    })
    this.trace = Object.freeze(sink)
  }

  /** Captures a summary only after AML has closed the complete evaluation span. */
  #record(event: AmlTraceEvent): void {
    this.#collector.trace(event)
    if (event.type === "event" && event.name === "acp.session.prompt.completed") {
      const sessionId = event.attributes.sessionId
      const stopReason = event.attributes.stopReason
      if (typeof sessionId === "string" && sessionId && typeof stopReason === "string" && stopReason) {
        this.#providerCompletions.push(
          Object.freeze({
            runId: event.runId,
            sessionId,
            stopReason
          })
        )
      }
    }
    if (event.type !== "span.end" || event.kind !== "evaluation") {
      return
    }

    const summary = this.#collector.forRun(event.runId)
    if (summary) {
      this.#completed.push(summary)
      this.#collector.deleteRun(event.runId)
    }
  }

  /** Preserves null when a provider never emitted a particular usage metric. */
  #sum(total: number | null, value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? (total || 0) + value : total
  }

  /** Returns immutable, content-free summaries in evaluation completion order. */
  summaries(): readonly TraceSummary[] {
    return Object.freeze([...this.#completed])
  }

  /** Preserves content-free ACP completion evidence in provider event order. */
  providerCompletions(): readonly ReviewProviderCompletion[] {
    return Object.freeze([...this.#providerCompletions])
  }

  /** ACP usage is optional, so absence remains null instead of becoming zero. */
  usage(): ReviewUsage {
    let agentCalls = 0
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    let reasoningTokens: number | null = null
    let cacheReadTokens: number | null = null
    let cacheWriteTokens: number | null = null
    let totalTokens: number | null = null
    let costUsd: number | null = null

    for (const summary of this.#completed) {
      agentCalls += summary.agents.turns.count
      for (const serialized of summary.providerUsage) {
        try {
          const usage = JSON.parse(serialized) as Record<string, unknown>
          inputTokens = this.#sum(inputTokens, usage.inputTokens)
          outputTokens = this.#sum(outputTokens, usage.outputTokens)
          reasoningTokens = this.#sum(reasoningTokens, usage.thoughtTokens)
          cacheReadTokens = this.#sum(cacheReadTokens, usage.cachedReadTokens)
          cacheWriteTokens = this.#sum(cacheWriteTokens, usage.cachedWriteTokens)
          totalTokens = this.#sum(totalTokens, usage.totalTokens)
          costUsd = this.#sum(costUsd, usage.costUsd)
        } catch {
          // Provider telemetry must never decide whether a valid review completes.
        }
      }
    }

    return {
      agentCalls,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      costUsd
    }
  }
}
