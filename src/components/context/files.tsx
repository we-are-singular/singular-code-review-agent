import { File } from "@aml-jsx/sdk"

import {
  renderIssuesContext,
  renderPullRequestContext,
  renderPullRequestHistory
} from "../../lib/render/review-context.js"
import { useReviewContext } from "./review-context.js"

export const REVIEW_CONTEXT_PATHS = {
  pullRequest: ".singular-code-review/pr.md",
  diff: ".singular-code-review/pr.diff",
  history: ".singular-code-review/history.md",
  issues: ".singular-code-review/issues.md"
} as const

/** Materializes durable Agent evidence from the enriched review snapshot. */
export function ReviewContextFiles() {
  const { snapshot } = useReviewContext()
  return (
    <>
      <File path={REVIEW_CONTEXT_PATHS.pullRequest}>{renderPullRequestContext(snapshot)}</File>
      <File path={REVIEW_CONTEXT_PATHS.diff}>{snapshot.diff.text.trimEnd()}</File>
      <File path={REVIEW_CONTEXT_PATHS.history}>{renderPullRequestHistory(snapshot)}</File>
      <File path={REVIEW_CONTEXT_PATHS.issues}>{renderIssuesContext(snapshot)}</File>
    </>
  )
}
