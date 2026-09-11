import { estimateCostUsd } from "../../src/lib/review-pricing.ts";

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function formatCost(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "n/a";
}

export function priceUsage({ model, usage, reportedCostUsd = null }) {
  const reported = toNumber(reportedCostUsd);
  if (typeof reportedCostUsd === "number" && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0) {
    return {
      costUsd: reported,
      label: formatCost(reported),
      rawReportedCostUsd: reported,
      source: "provider",
    };
  }

  const costUsd = estimateCostUsd(model, {
    inputTokens: toNumber(usage?.inputTokens),
    outputTokens: toNumber(usage?.outputTokens),
    reasoningTokens: toNumber(usage?.reasoningTokens),
    cacheReadTokens: toNumber(usage?.cacheReadTokens),
    cacheWriteTokens: toNumber(usage?.cacheWriteTokens),
  });
  if (costUsd === null) {
    // Subscription-backed ACPs and newly added provider models do not share a
    // reliable token price. An unavailable cost is safer than a fake fallback.
    return {
      costUsd: null,
      label: "n/a",
      rawReportedCostUsd: 0,
      source: "unavailable",
    };
  }

  return {
    costUsd,
    label: formatCost(costUsd),
    rawReportedCostUsd: 0,
    source: "price-table",
  };
}
