import { createTraceSummaryCollector, type AmlTraceEvent, type TraceSink, type TraceSummary } from "@aml-jsx/sdk"

export type ReviewUsage = {
  agentCalls: number
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  totalTokens: number | null
  costUsd: number | null
}

/** Collects content-free AML summaries and provider-optional usage per evaluation. */
export class ReviewTelemetryCollector {
  readonly #collector = createTraceSummaryCollector()
  readonly #completed: TraceSummary[] = []

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
    if (event.type !== "span.end" || event.kind !== "evaluation") {
      return
    }

    const summary = this.#collector.forRun(event.runId)
    if (summary) {
      this.#completed.push(summary)
      this.#collector.deleteRun(event.runId)
    }
  }

  #sum(total: number | null, value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? (total || 0) + value : total
  }

  /** Returns immutable, content-free summaries in evaluation completion order. */
  summaries(): readonly TraceSummary[] {
    return Object.freeze([...this.#completed])
  }

  /** ACP usage is optional, so absence remains null instead of becoming zero. */
  usage(): ReviewUsage {
    let agentCalls = 0
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    let reasoningTokens: number | null = null
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
      totalTokens,
      costUsd
    }
  }
}
