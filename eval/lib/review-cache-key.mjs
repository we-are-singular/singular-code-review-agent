import { sha256Json, sha256Text } from "./cache.mjs";

export const REVIEW_CACHE_VERSION = 6;

export function reviewCacheKey({ model, input, context, diffText }) {
  return sha256Json({
    version: REVIEW_CACHE_VERSION,
    capture: "docker-review-dry-run",
    model,
    input: {
      repository: input.repository,
      number: input.number,
      ref: input.ref,
      ignoreHistory: Boolean(input.ignoreHistory),
      baseSha: context.baseSha || null,
      headSha: context.headSha || null,
      label: input.label || "",
      notes: input.notes || "",
    },
    contextHash: sha256Json(context),
    diffHash: sha256Text(diffText),
  });
}
