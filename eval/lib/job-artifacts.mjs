import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const REQUIRED_ARTIFACTS = [
  "review.md",
  "review_transcript.md",
  "review_comments.json",
  "review_stats.json",
  "provider_completions.jsonl",
  "artifacts/pr.diff",
  "artifacts/review_model_context.json",
]

/** Canonical files are useful for timeout diagnostics even when the result failed. */
export function canonicalJobArtifacts(jobDir) {
  const filesPresent = REQUIRED_ARTIFACTS.every((relative) => {
    const file = join(jobDir, relative)
    return existsSync(file) && statSync(file).size > 0
  })
  if (!filesPresent) {
    return false
  }
  try {
    JSON.parse(readFileSync(join(jobDir, "review_comments.json"), "utf8"))
    JSON.parse(readFileSync(join(jobDir, "review_stats.json"), "utf8"))
    const completions = readFileSync(join(jobDir, "provider_completions.jsonl"), "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(line => JSON.parse(line))
    if (
      completions.length === 0 ||
      completions.some(
        completion =>
          !completion ||
          typeof completion !== "object" ||
          typeof completion.runId !== "string" ||
          !completion.runId ||
          typeof completion.sessionId !== "string" ||
          !completion.sessionId ||
          typeof completion.stopReason !== "string" ||
          !completion.stopReason
      )
    ) {
      return false
    }
    return true
  } catch {
    return false
  }
}

/** A completed capture is reusable only when its result and all judge inputs exist. */
export function completedJobArtifacts(jobDir) {
  const resultFile = join(jobDir, "result.json")
  if (!existsSync(resultFile)) {
    return false
  }
  try {
    if (JSON.parse(readFileSync(resultFile, "utf8")).status !== "completed") {
      return false
    }
  } catch {
    return false
  }
  return canonicalJobArtifacts(jobDir)
}
