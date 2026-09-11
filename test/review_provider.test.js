import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import test from "node:test"
import { Agent, AmlRuntime } from "@aml-jsx/sdk"
import { jsx } from "@aml-jsx/sdk/jsx-runtime"

import { createReviewProvider } from "../dist/lib/review-provider.js"

test("production OpenCode launch disables titles without disabling compaction", async t => {
  const directory = mkdtempSync(join(tmpdir(), "review-provider-config-"))
  const capture = join(directory, "config.json")
  const command = join(directory, "opencode")
  const quotedCapture = `'${capture.replaceAll("'", "'\\''")}'`
  // Capture the effective launch config and exit before starting any ACP/model work.
  writeFileSync(command, `#!/bin/sh\nprintf '%s' "$OPENCODE_CONFIG_CONTENT" > ${quotedCapture}\nexit 1\n`)
  chmodSync(command, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${directory}${delimiter}${previousPath || ""}`
  t.after(() => {
    process.env.PATH = previousPath
    rmSync(directory, { recursive: true, force: true })
  })

  const provider = createReviewProvider({ model: "opencode-go/deepseek-v4-flash", workspace: directory })
  const runtime = new AmlRuntime({ agentProvider: provider })
  await assert.rejects(
    runtime.evaluate(jsx(Agent, { children: "Offline configuration check." }), {
      signal: AbortSignal.timeout(5000)
    })
  )
  const config = JSON.parse(readFileSync(capture, "utf8"))
  assert.equal(config.agent.title.disable, true)
  assert.notEqual(config.agent.compaction?.disable, true)
  assert.equal(config.tools.task, false)
})
