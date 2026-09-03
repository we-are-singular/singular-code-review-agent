const MAX_REVIEW_BODY_LENGTH = 6_000

/**
 * Converts provider-qualified model ids into the compact label shown in the
 * programmatic review banner.
 */
export function modelLabel(modelId: string): string {
  return modelId.split("/").filter(Boolean).pop() || modelId || "unknown"
}

/**
 * Adds the runner-owned model banner exactly once from the runner perspective.
 * The function deliberately does not sanitize model output that includes a
 * banner, because the synthesis prompt owns that output contract.
 */
export function applyReviewBanner(body: string, modelId: string): string {
  const trimmed = body.trim()
  const banner = `> reviewer · ${modelLabel(modelId)}`
  return trimmed ? `${banner}\n\n${trimmed}` : banner
}

/**
 * Keeps the top-level review body within a conservative size limit while
 * preserving the inline comments as the source of detailed findings.
 */
export function enforceReviewBodyLimit(body: string, maxLength = MAX_REVIEW_BODY_LENGTH): string {
  if (body.length <= maxLength) {
    return body
  }

  const suffix = "\n\n[Review body truncated]"
  if (maxLength <= suffix.length) {
    return suffix.slice(0, maxLength)
  }
  return `${body.slice(0, maxLength - suffix.length).trimEnd()}${suffix}`
}
