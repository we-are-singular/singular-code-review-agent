import { defineTool, type AmlJsonValue } from "@aml-jsx/sdk"
import { z } from "zod"

import type { GitHubReviewSession } from "../services/github-session.js"

const RepositorySchema = z
  .string()
  .trim()
  .regex(/^[^/\s]+\/[^/\s]+$/u, "repository must use owner/name format")
  .optional()
  .describe("Referenced owner/name repository; omit for the active repository")
const PullRequestReferenceSchema = z
  .object({
    pull_number: z.number().int().positive(),
    repository: RepositorySchema
  })
  .strict()
const IssueReferenceSchema = z
  .object({
    issue_number: z.number().int().positive(),
    repository: RepositorySchema
  })
  .strict()

/** Copies Octokit responses into AML's serializable Tool result boundary. */
function json(value: unknown): AmlJsonValue {
  return JSON.parse(JSON.stringify(value)) as AmlJsonValue
}

/** Grants focused, read-only lookup for references mentioned by review evidence. */
export function createGitHubReadTools(session: GitHubReviewSession) {
  return {
    getPullRequest: defineTool({
      name: "get_pull_request",
      description: "Read metadata for a referenced pull request",
      input: PullRequestReferenceSchema,
      execute: async ({ pull_number, repository }) => json(await session.getPullRequest(pull_number, repository))
    }),
    getPullRequestDiff: defineTool({
      name: "get_pull_request_diff",
      description: "Read the filtered unified diff for a referenced pull request",
      input: PullRequestReferenceSchema,
      execute: async ({ pull_number, repository }) => (await session.getPullRequestDiff(pull_number, repository)).text
    }),
    getIssue: defineTool({
      name: "get_issue",
      description: "Read a referenced issue or pull-request issue record",
      input: IssueReferenceSchema,
      execute: async ({ issue_number, repository }) => json(await session.getIssue(issue_number, repository))
    }),
    listIssueComments: defineTool({
      name: "list_issue_comments",
      description: "Read the chronological comments on a referenced issue or pull request",
      input: IssueReferenceSchema,
      execute: async ({ issue_number, repository }) => json(await session.listIssueComments(issue_number, repository))
    }),
    getCommit: defineTool({
      name: "get_commit",
      description: "Read one referenced commit by SHA, branch, or tag",
      input: z
        .object({
          ref: z.string().trim().min(1).max(255),
          repository: RepositorySchema
        })
        .strict(),
      execute: async ({ ref, repository }) => json(await session.getCommit(ref, repository))
    })
  }
}
