// Offline integration probe. Run in the stock reviewer image with --network none;
// docs/cost-telemetry.md contains the exact command. No real model is contacted.
import assert from "node:assert/strict"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { AmlRuntime, Agent, Parallel, opencodeAgent } from "@aml-jsx/sdk"
import { jsx } from "@aml-jsx/sdk/jsx-runtime"

import { OpenCodeUsage } from "../../dist/lib/opencode-usage.js"
import { ReviewTelemetryCollector } from "../../dist/lib/review-telemetry.js"
import prices from "../../dist/model-prices.json" with { type: "json" }

const mode = process.env.FIXTURE_MODE ?? "normal"
assert.ok(["normal", "retry", "failure", "parallel"].includes(mode))
const databaseUsage = new OpenCodeUsage()
assert.ok(databaseUsage.directory)
const readPath = `${databaseUsage.directory}/context.txt`
writeFileSync(readPath, "A local fixture for the read tool.\n")
prices["fixture/counter"] = [1, 2, 0.1, 0.2]
const requests = []
let failedOnce = false
const server = createServer(async (req, res) => {
  let raw = ""
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  const main = body.tools?.some(tool => tool.function?.name === "read") === true
  const continuation = body.messages.some(message => message.role === "tool")
  if (main && continuation && !failedOnce && ["retry", "failure"].includes(mode)) {
    failedOnce = true
    requests.push({ main, status: mode === "retry" ? 503 : 400, tokens: null })
    res.writeHead(mode === "retry" ? 503 : 400, { "content-type": "application/json", "retry-after": "0" })
    res.end(JSON.stringify({ error: { message: "Fixture failure", type: "api_error" } }))
    return
  }
  const step = continuation ? 2 : 1
  requests.push({ main, status: 200, tokens: 1200 * step })
  assert.ok(requests.length <= 8, "unexpected model loop")
  res.writeHead(200, { "content-type": "text/event-stream" })
  const chunk = (delta, finish_reason = null, extra = {}) =>
    res.write(
      `data: ${JSON.stringify({
        id: `fixture-${requests.length}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "counter",
        choices: [{ index: 0, delta, finish_reason }],
        ...extra
      })}\n\n`
    )
  const callRead = main && !continuation
  chunk({ role: "assistant" })
  chunk(
    callRead
      ? {
          tool_calls: [
            {
              index: 0,
              id: "read-1",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ filePath: readPath })
              }
            }
          ]
        }
      : { content: "Fixture complete." }
  )
  chunk({}, callRead ? "tool_calls" : "stop", {
    usage: {
      prompt_tokens: 1100 * step,
      completion_tokens: 100 * step,
      total_tokens: 1200 * step,
      prompt_tokens_details: { cached_tokens: 1000 * step },
      completion_tokens_details: { reasoning_tokens: 20 * step }
    }
  })
  res.end("data: [DONE]\n\n")
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))

try {
  const telemetry = new ReviewTelemetryCollector()
  const provider = opencodeAgent({
    command: fileURLToPath(new URL("../../dist/lib/opencode-usage.sh", import.meta.url)),
    directory: "/tmp",
    model: "fixture/counter",
    env: {
      REVIEW_OPENCODE_USAGE_DIRECTORY: databaseUsage.directory,
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_PROJECT_CONFIG: "true"
    },
    config: {
      agent: { title: { disable: true } },
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture-only" },
          models: {
            counter: {
              name: "Counter",
              limit: { context: 128000, output: 8192 },
              cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 }
            }
          }
        }
      },
      tools: { "*": false, read: true },
      small_model: "fixture/counter"
    }
  })
  const runtime = new AmlRuntime({ agentProvider: provider, trace: telemetry.trace })
  const agent = () => jsx(Agent, { children: `Read ${readPath}, then respond with Fixture complete.` })
  let collectedInsideTree = false
  const Collect = () => {
    // Prove the last tree step runs after AML removed each invocation directory.
    for (const file of readdirSync(databaseUsage.directory).filter(name => name.endsWith(".db"))) {
      assert.equal(existsSync(`/tmp/${file.slice(0, -3)}`), false)
    }
    databaseUsage.collect(telemetry.sessionIds())
    collectedInsideTree = true
    return null
  }
  let failed = false
  try {
    await runtime.evaluate(
      [mode === "parallel" ? jsx(Parallel, { children: [agent(), agent()] }) : agent(), jsx(Collect, {})],
      { signal: AbortSignal.timeout(45000) }
    )
  } catch (error) {
    if (mode !== "failure") throw error
    failed = true
  } finally {
    databaseUsage.collect(telemetry.sessionIds())
    databaseUsage.close()
  }
  const result = databaseUsage.apply(telemetry.usage("fixture/counter"))
  const count = mode === "parallel" ? 2 : 1
  const expected = mode === "failure" ? 1200 : 3600 * count
  assert.equal(failed, mode === "failure")
  assert.equal(collectedInsideTree, mode !== "failure")
  assert.equal(result.usageSource, "opencode-db")
  assert.equal(result.usage.totalTokens, expected)
  assert.ok(
    requests.every(request => request.main),
    "title generation must not make auxiliary requests"
  )
  assert.equal(
    result.usage.totalTokens,
    requests.filter(request => request.main).reduce((sum, request) => sum + (request.tokens ?? 0), 0)
  )
  assert.equal(result.usage.agentCalls, count)
  if (mode !== "failure") assert.equal(result.amlUsage.totalTokens, 2400 * count)
  assert.equal(result.usage.costUsd, null)
  assert.ok(Math.abs(result.usage.estimatedCostUsd - (mode === "failure" ? 0.0004 : 0.0012 * count)) < 1e-12)
  assert.equal(existsSync(databaseUsage.directory), false)
  console.log(JSON.stringify({ mode, collectedInsideTree, requests, ...result }, null, 2))
} finally {
  databaseUsage.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
