import { Agent, evaluate, Skill, Tool } from "@aml-jsx/sdk"

import { Context7 } from "../context7.js"
import { REVIEW_CONTEXT_PATHS } from "../review-context-files.js"
import { useReview } from "../review-context.js"
import type { ReviewLaneName } from "../../lib/review-queue.js"
import { createGitHubReadTools } from "../../tools/github-read.js"
import { createReviewTools } from "../../tools/review.js"

export type ReviewLaneProps = {
  lane: ReviewLaneName
  system: string
  prompt: string
}

/** Runs one focused specialist and suppresses its non-canonical terminal prose. */
export async function ReviewLane({ lane, system, prompt }: ReviewLaneProps) {
  const { github, queue, snapshot } = useReview()
  const tools = createReviewTools(queue, lane)
  const githubTools = createGitHubReadTools(github)
  const changedFiles = snapshot.diff.files.map(path => `- ${path}`).join("\n") || "- (none)"

  const assessment = await evaluate(
    <Agent name={lane} permissions={{ filesystem: "read-only", network: false, shell: false }} system={system}>
      <Skill name="Evidence-first review lane" src="./skills/lane.md" />
      <Context7 />
      <Tool use={githubTools.getPullRequest} />
      <Tool use={githubTools.getPullRequestDiff} />
      <Tool use={githubTools.getIssue} />
      <Tool use={githubTools.listIssueComments} />
      <Tool use={githubTools.getCommit} />
      <Tool use={tools.addReviewComment} />
      <Tool use={tools.addReviewReply} />
      <Tool use={tools.addReviewBlocker} />
      {`
## Review context

The review is materialized in these workspace-relative files:
- ${REVIEW_CONTEXT_PATHS.pullRequest}: PR description, refs, changed files, and commits
- ${REVIEW_CONTEXT_PATHS.diff}: filtered unified diff
- ${REVIEW_CONTEXT_PATHS.history}: prior comments, reviews, threads, and timeline

Changed files:
${changedFiles}

Begin with ${REVIEW_CONTEXT_PATHS.pullRequest} and ${REVIEW_CONTEXT_PATHS.diff}. Read ${REVIEW_CONTEXT_PATHS.history} when the trigger, prior feedback, or author decisions matter.

## Lane assignment

Your lane is \`${lane}\`.

${prompt}`}
    </Agent>
  )

  queue.complete(lane, assessment)
  return ""
}
