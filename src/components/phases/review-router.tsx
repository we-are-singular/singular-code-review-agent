import { evaluate, type AmlRenderable } from "@aml-jsx/sdk"

import { useReviewContext } from "../review-context.js"
import { decideReviewGate } from "./review-gate.js"

/** Gives every confident no-review decision the same idempotent approval marker. */
function approvalBody(answer: string): string {
  // Providers occasionally include the marker despite the prompt. Normalize
  // only that exact terminal contract before appending the application-owned line.
  const withoutExistingVerdict = answer.replace(/(?:^|\n+)\s*✅\s*LGTM\.?\s*$/u, "").trim()
  return withoutExistingVerdict ? `${withoutExistingVerdict}\n\n✅ LGTM` : "✅ LGTM"
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
      routing.complete(gate, approvalBody(gate.answer))
      return null
  }
}
