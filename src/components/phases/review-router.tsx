import { evaluate, type AmlRenderable } from "@aml-jsx/sdk"

import type { GateDeltaMode } from "../../lib/review-gate.js"
import { useReviewContext } from "../context/review-context.js"
import { decideReviewGate } from "./review-gate.js"

/** Gives every confident no-review decision the same verdict shape as a full review. */
function approvalBody(answer: string, comparisonMode: GateDeltaMode | null): string {
  // Providers occasionally include the marker despite the prompt. Normalize
  // only that exact terminal contract before appending the application-owned lines.
  const withoutOwnedTail = answer.replace(/(?:^|\n+)\s*#{1,6}\s*verdict\s*(?:\n+\s*✅\s*LGTM\.?)?\s*$/giu, "").trim()
  const withoutExistingVerdict = withoutOwnedTail.replace(/(?:^|\n+)\s*✅\s*LGTM\.?\s*$/u, "").trim()
  if (!withoutExistingVerdict) {
    return "## Verdict\n\n✅ LGTM"
  }
  const heading =
    comparisonMode === "ancestor_diff" || comparisonMode === "rebase_compare" ? "Since last review" : "Review Summary"
  return `## ${heading}\n\n${withoutExistingVerdict}\n\n## Verdict\n\n✅ LGTM`
}

/** Selects one gate branch and completes the routing handoff for publication. */
export async function ReviewRouter({ children }: { children: AmlRenderable }) {
  const { routing } = useReviewContext()
  const gate = await decideReviewGate()

  switch (gate.decision) {
    case "review":
      routing.complete(gate, await evaluate(children))
      return null
    case "answer":
      routing.complete(gate, gate.answer)
      return null
    case "no-review":
      routing.complete(gate, approvalBody(gate.answer, gate.comparisonMode))
      return null
  }
}
