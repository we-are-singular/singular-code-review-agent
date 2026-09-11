import modelPrices from "../../src/model-prices.json" with { type: "json" };

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

  const prices = modelPrices[model];
  if (!Array.isArray(prices)) {
    // Subscription-backed ACPs and newly added provider models do not share a
    // reliable token price. An unavailable cost is safer than a fake fallback.
    return {
      costUsd: null,
      label: "n/a",
      rawReportedCostUsd: 0,
      source: "unavailable",
    };
  }

  const [inputPrice, outputPrice, cachePrice = 0, cacheWritePrice = 0] = prices;
  const inputTokens = toNumber(usage?.inputTokens);
  const outputTokens = toNumber(usage?.outputTokens) + toNumber(usage?.reasoningTokens);
  const cacheReadTokens = toNumber(usage?.cacheReadTokens);
  const cacheWriteTokens = toNumber(usage?.cacheWriteTokens);
  const costUsd =
    (inputTokens * inputPrice + outputTokens * outputPrice + cacheReadTokens * cachePrice + cacheWriteTokens * cacheWritePrice) / 1_000_000;

  return {
    costUsd,
    label: formatCost(costUsd),
    rawReportedCostUsd: 0,
    source: "price-table",
  };
}
