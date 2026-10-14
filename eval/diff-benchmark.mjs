import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { performance } from "node:perf_hooks"

// Run workers in fresh processes so peak RSS includes parsing and snapshot
// serialization, without fixture generation or an earlier trial's heap.
const args = process.argv.slice(2)
if (args[0] === "--worker") {
  const [compiled, manifest] = args.slice(1)
  const fixture = JSON.parse(readFileSync(manifest, "utf8"))
  const { GitHubReviewSession } = await import(pathToFileURL(join(compiled, "services/github/session.js")))
  const session = new GitHubReviewSession(
    {
      async getPullRequest() {
        return fixture.pullRequest
      },
      async getPullRequestDiff() {
        return readFileSync(fixture.rawPath, "utf8")
      }
    },
    fixture.request
  )
  const started = performance.now()
  const diff = await session.getPullRequestDiff()
  const loadMs = performance.now() - started
  const serializeStarted = performance.now()
  const snapshotBytes = Buffer.byteLength(JSON.stringify({ diff }))
  const serializeMs = performance.now() - serializeStarted
  // Compare complete anchor counts and coordinate sums across the old arrays
  // and new ranges without allocating an expanded copy in the new worker.
  const anchors = diff.files.map(file => ({
    path: file.path,
    status: file.status,
    lines: ["addedLines", "deletedLines", "rightLines", "leftLines"].map(key => {
      const values = file[key]
      let count = 0
      let sum = 0
      for (const value of values) {
        if (Array.isArray(value)) {
          const [first, last] = value
          const size = last - first + 1
          count += size
          sum += ((first + last) * size) / 2
        } else {
          count += 1
          sum += value
        }
      }
      return { count, sum }
    })
  }))
  process.stdout.write(
    JSON.stringify({
      loadMs,
      serializeMs,
      totalMs: loadMs + serializeMs,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      modelBytes: Buffer.byteLength(diff.text),
      snapshotBytes,
      anchors,
      ignoredFiles: diff.ignoredFiles,
      modelHash: createHash("sha256").update(diff.text).digest("hex")
    })
  )
} else {
  const option = (name, fallback) => {
    const index = args.indexOf(name)
    return index === -1 ? fallback : args[index + 1]
  }
  const before = option("--before")
  const after = option("--after", resolve("dist"))
  const runs = Number(option("--runs", "10"))
  const sizes = option("--lines", "1000,1000000,2500000").split(",").map(Number)
  const out = option("--out")
  if (
    !before ||
    !out ||
    !Number.isInteger(runs) ||
    runs < 1 ||
    sizes.some(size => !Number.isInteger(size) || size < 1)
  ) {
    throw new Error(
      "Usage: node eval/diff-benchmark.mjs --before <baseline dist> --after <candidate dist> --out <json> [--runs 10] [--lines 1000,1000000,2500000]"
    )
  }
  const temporary = mkdtempSync(join(tmpdir(), "singular-diff-benchmark-"))
  const results = []
  try {
    for (const deletedLines of sizes) {
      const workspace = join(temporary, String(deletedLines))
      execFileSync("git", ["init", "-q", workspace])
      const git = (...command) =>
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...command], {
          cwd: workspace,
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024
        })
      const commit = message => {
        git("add", "--", "retired.ts", "active.ts")
        git("-c", "user.name=Diff Benchmark", "-c", "user.email=benchmark@example.test", "commit", "-qm", message)
        return git("rev-parse", "HEAD").trim()
      }
      // Fixed 54-byte deletion lines match the large-diff stress shape.
      writeFileSync(join(workspace, "retired.ts"), ("// " + "retired ".repeat(6) + "xx\n").repeat(deletedLines))
      writeFileSync(join(workspace, "active.ts"), "export const active = false\n")
      const base = commit("base")
      rmSync(join(workspace, "retired.ts"))
      writeFileSync(join(workspace, "active.ts"), "export const active = true\n")
      const head = commit("head")
      const rawPath = join(temporary, String(deletedLines) + ".diff")
      writeFileSync(rawPath, git("diff", "--find-renames", base + "..." + head))
      const fixture = {
        rawPath,
        pullRequest: { number: 42, baseRefOid: base, headRefOid: head, additions: 1, deletions: deletedLines + 1 },
        request: {
          repository: "benchmark/repository",
          prNumber: 42,
          workspace,
          workspaceHeadSha: head,
          botLogin: "review-bot",
          eventName: null,
          eventPath: null,
          actor: null,
          ignoreHistory: true
        }
      }
      const manifest = join(temporary, String(deletedLines) + ".json")
      writeFileSync(manifest, JSON.stringify(fixture))
      for (let trial = 0; trial < runs; trial += 1) {
        // Alternate order to avoid always giving one variant warmer Git caches.
        const order =
          trial % 2
            ? [
                ["after", after],
                ["before", before]
              ]
            : [
                ["before", before],
                ["after", after]
              ]
        const pair = {}
        for (const [variant, compiled] of order) {
          const row = JSON.parse(
            execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--worker", resolve(compiled), manifest], {
              encoding: "utf8",
              maxBuffer: 1024 * 1024,
              timeout: 120_000
            })
          )
          pair[variant] = row
          results.push({ deletedLines, trial: trial + 1, variant, rawBytes: statSync(rawPath).size, ...row })
        }
        assert.equal(pair.before.modelHash, pair.after.modelHash)
        assert.deepEqual(pair.before.anchors, pair.after.anchors)
        assert.deepEqual(pair.before.ignoredFiles, pair.after.ignoredFiles)
        console.log(
          deletedLines +
            " trial " +
            (trial + 1) +
            ": " +
            pair.before.loadMs.toFixed(1) +
            " -> " +
            pair.after.loadMs.toFixed(1) +
            " ms load; " +
            Math.round(pair.before.peakRssBytes / 1048576) +
            " -> " +
            Math.round(pair.after.peakRssBytes / 1048576) +
            " MiB peak"
        )
      }
    }
    writeFileSync(
      resolve(out),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          node: process.version,
          before: resolve(before),
          after: resolve(after),
          runs,
          results
        },
        null,
        2
      ) + "\n"
    )
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
