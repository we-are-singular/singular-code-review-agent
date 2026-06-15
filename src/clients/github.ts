import { Octokit } from "@octokit/rest";
import { type ArtifactStore } from "../lib/artifacts.js";
import {
  type IssueComment,
  type PullRequestReview,
  type ReviewComment,
  type ReviewPayload,
  type ReviewThread,
  type ReviewThreadComment,
} from "../review/types.js";

export type PullRequestSummary = {
  number: number;
  title?: string | null;
  body?: string | null;
  author?: { login?: string | null } | null;
  user?: { login?: string | null } | null;
  baseRefName?: string | null;
  headRefName?: string | null;
  headRefOid?: string | null;
  baseRefOid?: string | null;
  url?: string | null;
  html_url?: string | null;
  isDraft?: boolean;
  draft?: boolean;
  reviewDecision?: string | null;
  head?: {
    repo?: {
      full_name?: string | null;
    } | null;
  } | null;
};

export type Reaction = {
  id: number;
  content: string;
  user?: {
    login?: string | null;
  } | null;
};

export type ReviewThreadsResult = {
  available: boolean;
  threads: ReviewThread[];
};

/**
 * Runner-owned GitHub facade. Live and dry-run clients share this contract so
 * workflow code never branches around GitHub writes.
 */
export type GitHubClient = {
  getPullRequest(prNumber: number): Promise<PullRequestSummary>;
  getPullRequestDiff(prNumber: number): Promise<string>;
  getIssueComment(commentId: number): Promise<IssueComment>;
  listIssueComments(prNumber: number): Promise<IssueComment[]>;
  listReviewComments(prNumber: number): Promise<ReviewComment[]>;
  listReviews(prNumber: number): Promise<PullRequestReview[]>;
  listReviewThreads(prNumber: number): Promise<ReviewThreadsResult>;
  listIssueCommentReactions(commentId: number): Promise<Reaction[]>;
  createIssueCommentReaction(commentId: number, content: "eyes"): Promise<void>;
  createIssueComment(prNumber: number, body: string): Promise<void>;
  submitReview(prNumber: number, payload: ReviewPayload): Promise<void>;
  submitReply(prNumber: number, commentId: number, body: string): Promise<void>;
};

export function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/", 2);
  if (!owner || !repo) {
    throw new Error("repository must use owner/name format");
  }
  return { owner, repo };
}

type GraphQLThreadNode = {
  id?: string | null;
  isResolved?: boolean | null;
  isOutdated?: boolean | null;
  path?: string | null;
  line?: number | null;
  startLine?: number | null;
  diffSide?: string | null;
  startDiffSide?: string | null;
  comments?: {
    nodes?: Array<{
      databaseId?: number | null;
      id?: string | null;
      body?: string | null;
      path?: string | null;
      line?: number | null;
      startLine?: number | null;
      diffSide?: string | null;
      startDiffSide?: string | null;
      createdAt?: string | null;
      url?: string | null;
      author?: {
        login?: string | null;
      } | null;
    }>;
  };
};

type GraphQLReviewThreadsResponse = {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        nodes?: GraphQLThreadNode[];
        pageInfo?: {
          hasNextPage?: boolean;
          endCursor?: string | null;
        };
      };
    } | null;
  } | null;
};

/**
 * Normalizes GraphQL review-thread nodes into the REST-like shape used by queue
 * validation and action-item discovery.
 */
function normalizeReviewThread(node: GraphQLThreadNode): ReviewThread {
  const comments: ReviewThreadComment[] = (node.comments?.nodes || []).map((comment) => ({
    id: comment.databaseId || null,
    node_id: comment.id || null,
    user: {
      login: comment.author?.login || null,
    },
    body: comment.body || "",
    path: comment.path || node.path || null,
    line: comment.line || node.line || null,
    start_line: comment.startLine || node.startLine || null,
    side: comment.diffSide || node.diffSide || "RIGHT",
    start_side: comment.startDiffSide || node.startDiffSide || null,
    created_at: comment.createdAt || null,
    html_url: comment.url || null,
  }));
  const firstComment = comments[0] || null;
  const latestComment = comments[comments.length - 1] || null;

  return {
    id: node.id || null,
    is_resolved: Boolean(node.isResolved),
    is_outdated: Boolean(node.isOutdated),
    path: node.path || firstComment?.path || null,
    line: node.line || firstComment?.line || null,
    start_line: node.startLine || firstComment?.start_line || null,
    side: node.diffSide || firstComment?.side || "RIGHT",
    start_side: node.startDiffSide || firstComment?.start_side || null,
    top_level_comment_id: firstComment?.id || null,
    top_level_author: firstComment?.user?.login || null,
    latest_author: latestComment?.user?.login || null,
    latest_comment_id: latestComment?.id || null,
    comments,
  };
}

/**
 * Creates the live Octokit-backed client used for all runner-owned GitHub API
 * reads and writes.
 */
export function createGitHubClient(options: { token: string; repository: string }): GitHubClient {
  const { owner, repo } = splitRepository(options.repository);
  const octokit = new Octokit({
    auth: options.token,
    userAgent: "singular-code-review-agent",
  });

  return {
    async getPullRequest(prNumber) {
      const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: prNumber,
      });
      return response.data as PullRequestSummary;
    },

    async getPullRequestDiff(prNumber) {
      const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: prNumber,
        mediaType: {
          format: "diff",
        },
      });
      return String(response.data || "");
    },

    async getIssueComment(commentId) {
      const response = await octokit.request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
        owner,
        repo,
        comment_id: commentId,
      });
      return response.data as IssueComment;
    },

    async listIssueComments(prNumber) {
      return (await octokit.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      })) as IssueComment[];
    },

    async listReviewComments(prNumber) {
      return (await octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      })) as ReviewComment[];
    },

    async listReviews(prNumber) {
      return (await octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      })) as PullRequestReview[];
    },

    async listReviewThreads(prNumber) {
      const query = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          diffSide
          startDiffSide
          comments(first: 100) {
            nodes {
              databaseId
              id
              body
              path
              line
              startLine
              diffSide
              startDiffSide
              createdAt
              url
              author {
                login
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;
      const threads: ReviewThread[] = [];
      let cursor: string | null = null;

      try {
        for (;;) {
          const response = (await octokit.graphql(query, {
            owner,
            name: repo,
            number: prNumber,
            cursor,
          })) as GraphQLReviewThreadsResponse;
          const connection = response.repository?.pullRequest?.reviewThreads;
          if (!connection || !Array.isArray(connection.nodes)) {
            // Review threads are a quality improvement, not a hard dependency.
            // Validation falls back to flat REST comments when this data is absent.
            return { available: false, threads: [] };
          }

          threads.push(...connection.nodes.map(normalizeReviewThread));
          if (!connection.pageInfo?.hasNextPage) {
            return { available: true, threads };
          }

          cursor = connection.pageInfo.endCursor || null;
          if (!cursor) {
            return { available: true, threads };
          }
        }
      } catch {
        // GraphQL thread access can fail for permissions or schema availability.
        // Treat that as unavailable context rather than failing the whole review.
        return { available: false, threads: [] };
      }
    },

    async listIssueCommentReactions(commentId) {
      return (await octokit.paginate("GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions", {
        owner,
        repo,
        comment_id: commentId,
        per_page: 100,
      })) as Reaction[];
    },

    async createIssueCommentReaction(commentId, content) {
      await octokit.request("POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions", {
        owner,
        repo,
        comment_id: commentId,
        content,
      });
    },

    async createIssueComment(prNumber, body) {
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: prNumber,
        body,
      });
    },

    async submitReview(prNumber, payload) {
      await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        owner,
        repo,
        pull_number: prNumber,
        body: payload.body,
        event: payload.event,
        comments: payload.comments,
      });
    },

    async submitReply(prNumber, commentId, body) {
      await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies", {
        owner,
        repo,
        pull_number: prNumber,
        comment_id: commentId,
        body,
      });
    },
  };
}

/**
 * Wraps a live read client while replacing all writes with artifact output.
 * This keeps dry runs close to production without posting to GitHub.
 */
export function createDryRunGitHubClient(delegate: GitHubClient, artifacts: ArtifactStore): GitHubClient {
  return {
    getPullRequest: (prNumber) => delegate.getPullRequest(prNumber),
    getPullRequestDiff: (prNumber) => delegate.getPullRequestDiff(prNumber),
    getIssueComment: (commentId) => delegate.getIssueComment(commentId),
    listIssueComments: (prNumber) => delegate.listIssueComments(prNumber),
    listReviewComments: (prNumber) => delegate.listReviewComments(prNumber),
    listReviews: (prNumber) => delegate.listReviews(prNumber),
    listReviewThreads: (prNumber) => delegate.listReviewThreads(prNumber),
    listIssueCommentReactions: (commentId) => delegate.listIssueCommentReactions(commentId),
    async createIssueCommentReaction(commentId, content) {
      artifacts.writeJson(artifacts.child(`dry-run-reaction-${commentId}.json`), { content });
    },
    async createIssueComment(prNumber, body) {
      artifacts.writeJson(artifacts.child(`dry-run-issue-comment-${prNumber}.json`), { body });
    },
    async submitReview(_prNumber, payload) {
      artifacts.writeJson(artifacts.paths.payloadFile, payload);
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    },
    async submitReply(_prNumber, commentId, body) {
      artifacts.writeJson(artifacts.child(`dry-run-reply-${commentId}.json`), { body });
      process.stdout.write(`${JSON.stringify({ reply_to: commentId, body }, null, 2)}\n`);
    },
  };
}
