import { Agent, evaluate, Skill, Tool, type AmlRenderable } from "@aml-jsx/sdk"

import { Block } from "../block.js"
import { Context7 } from "../context7.js"
import { REVIEW_CONTEXT_PATHS } from "../review-context-files.js"
import { ReviewContextPrompt } from "../review-context-prompt.js"
import { useReviewContext } from "../review-context.js"
import type { ReviewLaneName } from "../../lib/review-queue.js"
import { createGitHubReadTools } from "../../tools/github-read.js"
import { createReviewTools } from "../../tools/review.js"

export type ReviewLaneProps = {
  lane: ReviewLaneName
  children: AmlRenderable
}

/** Runs one focused specialist and hands its non-canonical assessment to audit. */
export async function ReviewLane({ lane, children }: ReviewLaneProps) {
  const { github, queue } = useReviewContext()
  const tools = createReviewTools(queue, lane)
  const githubTools = createGitHubReadTools(github)

  const assessment = await evaluate(
    <Agent name={lane} permissions={{ filesystem: "read-only", network: false, shell: false }}>
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
      {/* prettier-ignore */}
      <Block>
        ## Review context
        The review is materialized in these workspace-relative files:
        - {REVIEW_CONTEXT_PATHS.pullRequest}: PR description, refs, changed files, and commits
        - {REVIEW_CONTEXT_PATHS.diff}: filtered unified diff
        - {REVIEW_CONTEXT_PATHS.history}: prior comments, reviews, threads, and timeline
        <ReviewContextPrompt diff history />
        ## Lane assignment
        Your lane is `{lane}`.
      </Block>
      {children}
    </Agent>
  )

  queue.complete(lane, assessment)
  return <Block>{assessment}</Block>
}
