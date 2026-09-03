import { defineTool } from "@aml-jsx/sdk"
import { z } from "zod"

import { compactContextText } from "../services/github/context-model.js"
import {
  serializeFileChange,
  serializeIssueContext,
  serializePullRequestContext
} from "../services/github/context-serializer.js"
import type { GitHubReviewSession } from "../services/github/session.js"

const RepositorySchema = z
  .string()
  .trim()
  .regex(/^[^/\s]+\/[^/\s]+$/u, "repository must use owner/name format")
  .optional()
  .describe("Referenced owner/name repository; omit for the active repository")

/** Exposes complete but compact GitHub entities through literal read Tools. */
export function createGitHubReadTools(session: GitHubReviewSession) {
  return {
    // Serialization is disposable Tool work over cached endpoint responses;
    // the result never becomes request-scoped application state.
    getPullRequest: defineTool({
      name: "get_pr",
      description:
        "Get a referenced pull request with metadata, refs, git-status-like file lines (A/M/D plus churn; I means omitted from the review diff), one-line commits, one-line chronological comments/reviews/timeline, and full context for closing or explicitly related issues. The active pull request is already supplied in the review context; do not call this just in case",
      input: z
        .object({
          pull_number: z.number().int().positive(),
          repository: RepositorySchema
        })
        .strict(),
      execute: async ({ pull_number, repository }) => {
        const evidence = await session.context.pullRequest(pull_number, repository)
        return serializePullRequestContext(evidence.context, evidence.diff)
      }
    }),
    // Diffs remain separate because they dominate context size and many
    // reference-following calls need metadata or history without the patch.
    getPullRequestDiff: defineTool({
      name: "get_pr_diff",
      description: "Get the filtered unified diff for a pull request; lockfiles and binary hunks are omitted",
      input: z
        .object({
          pull_number: z.number().int().positive(),
          repository: RepositorySchema
        })
        .strict(),
      execute: async ({ pull_number, repository }) => (await session.getPullRequestDiff(pull_number, repository)).text
    }),
    // A literal issue read includes its decision history and rejects PR numbers
    // at the GraphQL boundary instead of inheriting REST's issue/PR conflation.
    getIssue: defineTool({
      name: "get_issue",
      description:
        "Get a real issue with metadata, its complete current description, and one-line chronological edits, comments, and timeline; pull-request numbers are rejected",
      input: z
        .object({
          issue_number: z.number().int().positive(),
          repository: RepositorySchema
        })
        .strict(),
      execute: async ({ issue_number, repository }) => {
        const { context } = await session.context.issue(issue_number, repository)
        return serializeIssueContext(context)
      }
    }),
    // Focused entity Tools recover exact evidence named by a compact history
    // entry without forcing Agents to reload the enclosing PR or issue.
    getComment: defineTool({
      name: "get_comment",
      description: "Get one top-level issue or pull-request comment by database id with compact body and metadata",
      input: z
        .object({
          comment_id: z.number().int().positive(),
          repository: RepositorySchema
        })
        .strict(),
      execute: async ({ comment_id, repository }) => {
        const comment = await session.getComment(comment_id, repository)
        return {
          id: comment.id,
          author: comment.user?.login || null,
          body: compactContextText(comment.body, 1_600),
          createdAt: comment.created_at || null,
          updatedAt: comment.updated_at || null,
          url: comment.html_url || null
        }
      }
    }),
    getCommit: defineTool({
      name: "get_commit",
      description: "Get one commit by SHA, branch, or tag with compact metadata and changed-file statistics",
      input: z
        .object({
          ref: z.string().trim().min(1).max(255),
          repository: RepositorySchema
        })
        .strict(),
      execute: async ({ ref, repository }) => {
        const commit = await session.getCommit(ref, repository)
        return {
          sha: commit.sha || ref,
          author: commit.author?.login || commit.committer?.login || commit.commit?.author?.name || null,
          at: commit.commit?.author?.date || commit.commit?.committer?.date || null,
          subject: compactContextText(String(commit.commit?.message || "").split(/\r?\n/u)[0]),
          url: commit.html_url || null,
          // REST uses extra states such as renamed/copied; those are still
          // modifications from the reviewer's compact file-inventory perspective.
          files: (commit.files || []).flatMap(file => {
            if (!file.filename) return []
            const status = file.status === "added" ? "added" : file.status === "removed" ? "removed" : "modified"
            return [serializeFileChange(status, file.filename, file.additions || 0, file.deletions || 0)]
          })
        }
      }
    })
  }
}
