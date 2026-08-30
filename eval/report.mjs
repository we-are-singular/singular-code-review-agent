import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { buildEvalSummary, evalRunStatus } from "./lib/analysis.mjs"
import { renderReport } from "./lib/report.mjs"

function readJson(file, fallback = null) {
  if (!existsSync(file)) {
    return fallback
  }
  return JSON.parse(readFileSync(file, "utf8"))
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function parseArgs(argv) {
  const options = {
    runDir: "",
    allowPartial: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--run") {
      options.runDir = resolve(argv[++index])
    } else if (arg === "--allow-partial") {
      options.allowPartial = true
    } else if (arg === "--help" || arg === "-h") {
      options.help = true
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }
  return options
}

function printHelp() {
  console.log(`Usage: node eval/report.mjs --run <dir>

Build summary.json and report.html from a capture run and optional judgments.

Options:
  --run <dir>       Completed capture run to report
  --allow-partial   Render diagnostics for a running/interrupted run. Partial
                    summaries remain ineligible for benchmark aggregation.
`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  if (!options.runDir) {
    throw new Error("--run is required")
  }

  const run = readJson(join(options.runDir, "run.json"))
  if (!run) {
    throw new Error(`missing run.json in ${options.runDir}`)
  }
  const status = evalRunStatus(run)
  if (status !== "completed" && !options.allowPartial) {
    throw new Error(`run status is ${status}; pass --allow-partial for a diagnostic report`)
  }
  const judgments = readJson(join(options.runDir, "judgments.json"), { judgments: [] }).judgments || []
  const summary = buildEvalSummary({ run: { ...run, status }, judgments, runDir: options.runDir })
  writeJson(join(options.runDir, "summary.json"), summary)
  writeFileSync(join(options.runDir, "report.html"), renderReport(summary))
  console.log(`report: ${join(options.runDir, "report.html")}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
