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

export type ReviewTelemetryOptions = {
  progress?: (line: string) => unknown
}

const PROGRESS_COMPONENTS = new Set([
  "Review",
  "ReviewContextFiles",
  "ReviewAcknowledgement",
  "ReviewRouter",
  "ReviewSynthesis",
  "ReviewAudit",
  "IntentContractLane",
  "StandardsArchitectureLane",
  "CodePathBugHunterLane",
  "CorrectnessRiskTestingLane",
  "DocumentationCommentaryLane",
  "MaintainabilityEleganceLane",
  "ReviewPublication"
])

type ProgressSpan = {
  parentSpanId?: string
  agentName?: string
  turnIndex?: number
  output: string
}

/** Renders only authored review boundaries and completed Agent responses. */
class ReviewProgressRenderer {
  readonly #spans = new Map<string, ProgressSpan>()
  readonly #write: (line: string) => unknown

  constructor(write: (line: string) => unknown) {
    this.#write = write
  }

  record(event: AmlTraceEvent): void {
    if (event.type === "span.start") {
      this.#start(event)
      return
    }
    if (event.type === "event") {
      this.#content(event)
      return
    }
    this.#end(event)
  }

  #start(event: Extract<AmlTraceEvent, { type: "span.start" }>): void {
    const span: ProgressSpan = {
      ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}),
      ...(event.name === "agent.session" && typeof event.attributes.name === "string"
        ? { agentName: event.attributes.name }
        : {}),
      ...(event.name === "agent.turn" && typeof event.attributes.index === "number"
        ? { turnIndex: event.attributes.index }
        : {}),
      output: ""
    }
    this.#spans.set(event.spanId, span)

    if (event.kind === "component" && PROGRESS_COMPONENTS.has(event.name)) {
      this.#write(`▶ component ${event.name}`)
    } else if (event.name === "agent.turn") {
      this.#write(`▶ turn ${this.#turnLabel(span)}`)
    }
  }

  #content(event: Extract<AmlTraceEvent, { type: "event" }>): void {
    const span = this.#spans.get(event.spanId)
    if (!span) {
      return
    }
    if (event.name === "acp.session.update" && event.attributes.sessionUpdate === "agent_message_chunk") {
      const update = this.#jsonObject(event.attributes.update)
      const content = this.#jsonObject(update?.content)
      if (content?.type === "text" && typeof content.text === "string") {
        span.output += content.text
      }
    } else if (event.name === "agent.output" && !span.output) {
      const output = event.attributes.output
      if (typeof output === "string") {
        span.output = output
      }
    }
  }

  #end(event: Extract<AmlTraceEvent, { type: "span.end" }>): void {
    const span = this.#spans.get(event.spanId)
    if (!span) {
      return
    }
    if (event.kind === "component" && PROGRESS_COMPONENTS.has(event.name)) {
      this.#write(`${event.status === "ok" ? "✓" : "✗"} component ${event.name} ${this.#duration(event.durationMs)}`)
    } else if (event.name === "agent.turn") {
      const status = event.status === "ok" ? "✓" : "✗"
      this.#write(`${status} turn ${this.#turnLabel(span)} ${this.#duration(event.durationMs)}`)
      const output = span.output.trim()
      if (output) {
        for (const line of output.split("\n")) {
          this.#write(`  │ ${line}`)
        }
      }
    }
    this.#spans.delete(event.spanId)
  }

  #turnLabel(span: ProgressSpan): string {
    const session = span.parentSpanId ? this.#spans.get(span.parentSpanId) : undefined
    const name = session?.agentName || "agent"
    return `${name} #${span.turnIndex || 1}`
  }

  #jsonObject(value: unknown): Record<string, unknown> | null {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
    if (typeof value !== "string") {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(value)
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }

  #duration(durationMs: number): string {
    return durationMs < 10 ? `${durationMs.toFixed(1)}ms` : `${Math.round(durationMs)}ms`
  }
}

/** Collects content-free AML summaries and provider-optional usage per evaluation. */
export class ReviewTelemetryCollector {
  readonly #collector = createTraceSummaryCollector()
  readonly #completed: TraceSummary[] = []
  readonly #providerCompletions: ReviewProviderCompletion[] = []
  readonly #progress?: ReviewProgressRenderer

  readonly trace: TraceSink

  constructor(options: ReviewTelemetryOptions = {}) {
    if (options.progress) {
      this.#progress = new ReviewProgressRenderer(options.progress)
    }
    const sink = ((event: AmlTraceEvent) => this.#record(event)) as TraceSink
    Object.defineProperty(sink, "captureContent", {
      configurable: false,
      enumerable: true,
      // Agent text is sensitive trace content. Opt in only when the caller
      // requested human-readable progress, then emit completed responses only.
      value: Boolean(options.progress),
      writable: false
    })
    this.trace = Object.freeze(sink)
  }

  /** Captures a summary only after AML has closed the complete evaluation span. */
  #record(event: AmlTraceEvent): void {
    this.#collector.trace(event)
    this.#progress?.record(event)
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
