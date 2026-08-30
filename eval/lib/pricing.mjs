export const PRICES_USD_PER_MILLION = {
  "opencode/deepseek-v4-flash-free": [0.09, 0.18, 0.018],
  "opencode/mimo-v2.5-free": [0.105, 0.28, 0.028],
  "openrouter/tencent/hy3:free": [0.14, 0.58, 0.035],
  "opencode/hy3-free": [0.14, 0.58, 0.035],
  "openrouter/poolside/laguna-m.1:free": [0.2, 0.4, 0.1],
  "openrouter/google/gemma-4-31b-it:free": [0.12, 0.35, 0.09],
  "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free": [0.5, 2.2, 0.1],
  "opencode/nemotron-3-ultra-free": [0.5, 2.2, 0.1],
  "opencode/north-mini-code-free": [1, 3, 1],
};

const FALLBACK_PRICE_USD_PER_MILLION = [1, 3, 1];

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function formatCost(value) {
  return `$${toNumber(value).toFixed(4)}`;
}

export function priceUsage({ model, usage, reportedCostUsd = 0 }) {
  const reported = toNumber(reportedCostUsd);
  if (reported > 0) {
    return {
      costUsd: reported,
      label: formatCost(reported),
      rawReportedCostUsd: reported,
    };
  }

  const [inputPrice, outputPrice, cachePrice] =
    PRICES_USD_PER_MILLION[String(model || "").toLowerCase()] || FALLBACK_PRICE_USD_PER_MILLION;
  const inputTokens = toNumber(usage?.inputTokens);
  const outputTokens = toNumber(usage?.outputTokens);
  const cacheReadTokens = Math.min(toNumber(usage?.cacheReadTokens), inputTokens);
  const uncachedInputTokens = Math.max(0, inputTokens - cacheReadTokens);
  const costUsd =
    (uncachedInputTokens * inputPrice) / 1_000_000 +
    (outputTokens * outputPrice) / 1_000_000 +
    (cacheReadTokens * cachePrice) / 1_000_000;

  return {
    costUsd,
    label: formatCost(costUsd),
    rawReportedCostUsd: 0,
  };
}
