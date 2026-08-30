import { sha256Json, sha256Text } from "./cache.mjs";

export const REVIEW_CACHE_VERSION = 17;

export function reviewCacheKey({ runner = "src", provider, model, reviewerImageId, input, context, diffText }) {
  return sha256Json({
    version: REVIEW_CACHE_VERSION,
    capture: "review-dry-run",
    runner,
    provider: runner === "aml" ? provider || "opencode" : null,
    model,
    // The same PR and model can produce materially different evidence after a
    // reviewer rebuild. Never restore a capture from another image revision.
    reviewerImageId: reviewerImageId || null,
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
