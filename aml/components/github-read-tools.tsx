import { Tool } from "@aml-jsx/sdk"

import { useReview } from "../review-context.js"
import { createGitHubReadTools } from "../tools/github.js"

/** Grants every read-only GitHub capability, and no mutation capability. */
export function GitHubReadTools() {
  const { github } = useReview()
  const tools = createGitHubReadTools(github)

  return (
    <>
      <Tool use={tools.getPullRequest} />
      <Tool use={tools.getPullRequestDiff} />
      <Tool use={tools.getIssueComment} />
      <Tool use={tools.listIssueComments} />
      <Tool use={tools.listReviewComments} />
      <Tool use={tools.listReviews} />
      <Tool use={tools.listPullRequestCommits} />
      <Tool use={tools.listReviewThreads} />
      <Tool use={tools.listIssueCommentReactions} />
    </>
  )
}
