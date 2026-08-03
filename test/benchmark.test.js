import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const benchmark = path.join(repoRoot, "eval", "benchmark.mjs")

function writeSummary(root, name, score) {
  const runDir = path.join(root, name)
  fs.mkdirSync(runDir, { recursive: true })
  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify({
      generatedAt: `2026-08-02T00:00:0${score}Z`,
      results: [
        {
          pr: "owner/repo#1",
          model: "opencode-go/example:variant",
          status: "passed",
          scorePercent: score,
          durationMs: 60_000,
          producedComments: 1,
          usage: {
            totalTokens: 100,
            inputTokens: 10,
            outputTokens: 20,
            reasoningTokens: 30,
            cacheReadTokens: 40,
            cacheWriteTokens: 0,
            costUsd: 0.01
          },
          questions: []
        }
      ]
    })
  )
}

test("benchmark --avg keeps repeated captures and groups them by exact model variant", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "singular-benchmark-"))
  try {
    writeSummary(root, "wave-a", 70)
    writeSummary(root, "wave-b", 90)
    const json = path.join(root, "benchmark.json")
    const html = path.join(root, "benchmark.html")

    execFileSync(process.execPath, [benchmark, "--runs", root, "--avg", "--json", json, "--out", html], {
      cwd: repoRoot
    })

    const summary = JSON.parse(fs.readFileSync(json, "utf8"))
    assert.equal(summary.models.length, 1)
    assert.equal(summary.models[0].model, "opencode-go/example:variant")
    assert.equal(summary.models[0].runs, 2)
    assert.equal(summary.models[0].averageScore, 80)
    assert.equal(summary.filters.average, true)
    assert.doesNotMatch(fs.readFileSync(html, "utf8"), /PR x Model Matrix/u)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
