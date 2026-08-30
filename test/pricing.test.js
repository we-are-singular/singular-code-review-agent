import assert from "node:assert/strict"
import test from "node:test"

import { priceUsage } from "../eval/lib/pricing.mjs"

const usage = { inputTokens: 1_000, outputTokens: 1_000, cacheReadTokens: 0 }

test("GLM 5.3 Flash uses the published OpenCode Go token prices", () => {
  const priced = priceUsage({
    model: "opencode-go/glm-5.3-flash",
    usage: { ...usage, cacheReadTokens: 1_000 }
  })

  assert.equal(priced.source, "price-table")
  assert.ok(Math.abs(priced.costUsd - 0.00068) < 1e-12)
})

test("DeepSeek V4 Flash fallback pricing follows the UTC peak schedule", () => {
  const offPeak = priceUsage({
    model: "opencode-go/deepseek-v4-flash",
    usage,
    startedAt: "2026-08-31T12:00:00.000Z"
  })
  const peak = priceUsage({
    model: "opencode-go/deepseek-v4-flash",
    usage,
    startedAt: "2026-08-31T02:00:00.000Z"
  })
  const unknown = priceUsage({ model: "opencode-go/deepseek-v4-flash", usage })

  assert.ok(Math.abs(offPeak.costUsd - 0.00088) < 1e-12)
  assert.ok(Math.abs(peak.costUsd - 0.00176) < 1e-12)
  assert.equal(unknown.source, "unavailable")
})

test("provider-reported cost remains authoritative", () => {
  const priced = priceUsage({
    model: "opencode-go/deepseek-v4-flash",
    usage,
    reportedCostUsd: 0.1234
  })

  assert.equal(priced.source, "provider")
  assert.equal(priced.costUsd, 0.1234)
})
