import { slugify } from "./pr-input.mjs"

/**
 * Keeps captures from different reviewer implementations distinct even when
 * they use the same PR and model.
 */
export function evalJobKey(job) {
  const runner = job.runner || "src"
  const reviewer = runner === "aml" ? `${runner}-${job.provider || "opencode"}` : runner
  return `${reviewer}__${job.input.slug}__${slugify(job.model)}`
}
