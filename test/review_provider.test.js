import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import test from "node:test"
import { Agent, AmlRuntime } from "@aml-jsx/sdk"
import { jsx } from "@aml-jsx/sdk/jsx-runtime"

import { createReviewProvider } from "../dist/lib/review-provider.js"

/** Launches a stub opencode that records one shell expression, then exits before any ACP/model work. */
async function captureLaunch(t, expression, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "review-provider-config-"))
  const capture = join(directory, "capture.txt")
  const command = join(directory, "opencode")
  const quotedCapture = `'${capture.replaceAll("'", "'\\''")}'`
  writeFileSync(command, `#!/bin/sh\nprintf '%s' ${expression} > ${quotedCapture}\nexit 1\n`)
  chmodSync(command, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${directory}${delimiter}${previousPath || ""}`
  t.after(() => {
    process.env.PATH = previousPath
    rmSync(directory, { recursive: true, force: true })
  })

  const provider = createReviewProvider({ model: "opencode-go/deepseek-v4-flash", workspace: directory, ...options })
  const runtime = new AmlRuntime({ agentProvider: provider })
  await assert.rejects(
    runtime.evaluate(jsx(Agent, { children: "Offline configuration check." }), {
      signal: AbortSignal.timeout(5000)
    })
  )
  return readFileSync(capture, "utf8")
}

test("production OpenCode launch disables titles without disabling compaction", async t => {
  const config = JSON.parse(await captureLaunch(t, '"$OPENCODE_CONFIG_CONTENT"'))
  assert.equal(config.agent.title.disable, true)
  assert.notEqual(config.agent.compaction?.disable, true)
  assert.equal(config.permission.task, "deny")
})

const catalogEnvironment = '"$OPENCODE_MODELS_PATH|$OPENCODE_DISABLE_MODELS_FETCH"'

test("every Agent reads the review's pinned model catalog instead of refreshing its own", async t => {
  const launched = await captureLaunch(t, catalogEnvironment, { modelsPath: "/pinned/models.json" })
  assert.equal(launched, "/pinned/models.json|true")
})

test("without a pinned catalog, Agents keep OpenCode's own catalog loading", async t => {
  assert.equal(await captureLaunch(t, catalogEnvironment), "|")
})
