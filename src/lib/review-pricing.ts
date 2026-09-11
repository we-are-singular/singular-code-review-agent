import modelPrices from "../model-prices.json" with { type: "json" }
import type { ReviewUsage } from "./review-telemetry.js"

/** Applies fixed USD-per-million rates to normalized, disjoint token counters. Unknown models have no estimate. */
export function estimateCostUsd(
  model: string,
  usage: Pick<ReviewUsage, "inputTokens" | "outputTokens" | "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens">
): number | null {
  const rates = (modelPrices as Record<string, number[]>)[model]
  if (!Array.isArray(rates)) return null
  const [input = 0, output = 0, read = 0, write = 0] = rates
  // OpenCode separates reasoning from output and cache hits/writes from input.
  return (
    ((usage.inputTokens ?? 0) * input +
      ((usage.outputTokens ?? 0) + (usage.reasoningTokens ?? 0)) * output +
      (usage.cacheReadTokens ?? 0) * read +
      (usage.cacheWriteTokens ?? 0) * write) /
    1_000_000
  )
}
