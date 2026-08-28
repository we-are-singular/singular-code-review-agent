import { Octokit } from "@octokit/rest"

import { createGitHubClient, splitRepository, type GitHubClient } from "../../src/clients/github.js"
import type { ReviewPayload } from "../../src/review/types.js"

export type AmlGitHubClient = GitHubClient & {
  submitReviewAtHead(prNumber: number, headSha: string, payload: ReviewPayload): Promise<void>
}

/**
 * Adds the AML publication invariant that the review belongs to the inspected
 * commit. The frozen source client intentionally keeps its existing contract.
 */
export function createAmlGitHubClient(options: { token: string; repository: string }): AmlGitHubClient {
  const delegate = createGitHubClient(options)
  const { owner, repo } = splitRepository(options.repository)
  const octokit = new Octokit({
    auth: options.token,
    userAgent: "singular-code-review-agent"
  })

  return {
    ...delegate,
    async submitReviewAtHead(prNumber, headSha, payload) {
      await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        owner,
        repo,
        pull_number: prNumber,
        commit_id: headSha,
        body: payload.body,
        event: payload.event,
        comments: payload.comments
      })
    }
  }
}
