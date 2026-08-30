export const PRICES_USD_PER_MILLION = {
  "opencode-go/glm-5.3-flash": [0.15, 0.5, 0.03],
  "opencode-go/ox-alpha-free": [0, 0, 0],
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

const OPENCODE_GO_DEEPSEEK_FLASH_PRICES = {
  offPeak: [0.22, 0.66, 0.007],
  peak: [0.44, 1.32, 0.014],
};

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function formatCost(value) {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "n/a";
}

function pricesForModel(model, startedAt) {
  const id = String(model || "").toLowerCase();
  if (id !== "opencode-go/deepseek-v4-flash") {
    return PRICES_USD_PER_MILLION[id];
  }

  const timestamp = Date.parse(startedAt || "");
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  const peak = weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  return peak ? OPENCODE_GO_DEEPSEEK_FLASH_PRICES.peak : OPENCODE_GO_DEEPSEEK_FLASH_PRICES.offPeak;
}

export function priceUsage({ model, usage, reportedCostUsd = 0, startedAt }) {
  const reported = toNumber(reportedCostUsd);
  if (reported > 0) {
    return {
      costUsd: reported,
      label: formatCost(reported),
      rawReportedCostUsd: reported,
      source: "provider",
    };
  }

  const prices = pricesForModel(model, startedAt);
  if (!prices) {
    // Subscription-backed ACPs and newly added provider models do not share a
    // reliable token price. An unavailable cost is safer than a fake fallback.
    return {
      costUsd: null,
      label: "n/a",
      rawReportedCostUsd: 0,
      source: "unavailable",
    };
  }

  const [inputPrice, outputPrice, cachePrice] = prices;
  const inputTokens = toNumber(usage?.inputTokens);
  const outputTokens = toNumber(usage?.outputTokens);
  const cacheReadTokens = toNumber(usage?.cacheReadTokens);
  const costUsd =
    (inputTokens * inputPrice) / 1_000_000 +
    (outputTokens * outputPrice) / 1_000_000 +
    (cacheReadTokens * cachePrice) / 1_000_000;

  return {
    costUsd,
    label: formatCost(costUsd),
    rawReportedCostUsd: 0,
    source: "price-table",
  };
}
