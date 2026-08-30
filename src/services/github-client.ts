import { Octokit } from "@octokit/rest"
import type { ReviewPayload } from "../lib/review-body.js"

export type GitHubUser = {
  login?: string | null
  type?: string | null
}

export type IssueComment = {
  id: number
  body?: string | null
  html_url?: string | null
  issue_url?: string | null
  author_association?: string | null
  created_at?: string | null
  updated_at?: string | null
  user?: GitHubUser | null
}

export type ReviewComment = {
  id: number
  body?: string | null
  path?: string | null
  line?: number | null
  start_line?: number | null
  startLine?: number | null
  side?: string | null
  start_side?: string | null
  startSide?: string | null
  in_reply_to_id?: number | null
  created_at?: string | null
  updated_at?: string | null
  html_url?: string | null
  url?: string | null
  pull_request_review_id?: number | null
  user?: GitHubUser | null
}

export type PullRequestReview = {
  id?: number | null
  body?: string | null
  state?: string | null
  submitted_at?: string | null
  submittedAt?: string | null
  html_url?: string | null
  url?: string | null
  commit_id?: string | null
  commitId?: string | null
  user?: GitHubUser | null
}

export type PullRequestCommit = {
  sha?: string | null
  html_url?: string | null
  author?: GitHubUser | null
  committer?: GitHubUser | null
  parents?: Array<{ sha?: string | null }> | null
  commit?: {
    message?: string | null
    author?: { name?: string | null; date?: string | null } | null
    committer?: { name?: string | null; date?: string | null } | null
  } | null
}

export type IssueSummary = {
  number: number
  title?: string | null
  body?: string | null
  state?: string | null
  html_url?: string | null
  pull_request?: { url?: string | null } | null
  user?: GitHubUser | null
}

export type RepositoryCommit = PullRequestCommit & {
  stats?: { additions?: number; deletions?: number; total?: number } | null
  files?: Array<{ filename?: string; status?: string; additions?: number; deletions?: number; changes?: number }> | null
}

export type ReviewThreadComment = {
  id: number | null
  node_id: string | null
  user: GitHubUser
  body: string
  path: string | null
  line: number | null
  start_line: number | null
  side: string | null
  start_side: string | null
  created_at: string | null
  html_url: string | null
}

export type ReviewThread = {
  id: string | null
  is_resolved: boolean
  is_outdated: boolean
  path: string | null
  line: number | null
  start_line: number | null
  side: string | null
  start_side: string | null
  top_level_comment_id: number | null
  top_level_author: string | null
  latest_author: string | null
  latest_comment_id: number | null
  comments: ReviewThreadComment[]
}

export type PullRequestSummary = {
  number: number
  title?: string | null
  body?: string | null
  author?: { login?: string | null } | null
  user?: { login?: string | null } | null
  baseRefName?: string | null
  headRefName?: string | null
  headRefOid?: string | null
  baseRefOid?: string | null
  url?: string | null
  html_url?: string | null
  isDraft?: boolean
  draft?: boolean
  reviewDecision?: string | null
  base?: {
    ref?: string | null
    sha?: string | null
  } | null
  head?: {
    ref?: string | null
    sha?: string | null
    repo?: {
      full_name?: string | null
    } | null
  } | null
}

export type Reaction = {
  id: number
  content: string
  user?: {
    login?: string | null
  } | null
}

export type ReviewThreadsResult = {
  available: boolean
  threads: ReviewThread[]
}

/**
 * Runner-owned GitHub facade. Live and dry-run clients share this contract so
 * workflow code never branches around GitHub writes.
 */
export type GitHubClient = {
  getPullRequest(prNumber: number, repository?: string): Promise<PullRequestSummary>
  getPullRequestDiff(prNumber: number, repository?: string): Promise<string>
  getIssue(issueNumber: number, repository?: string): Promise<IssueSummary>
  getCommit(ref: string, repository?: string): Promise<RepositoryCommit>
  getIssueComment(commentId: number): Promise<IssueComment>
  listIssueComments(issueNumber: number, repository?: string): Promise<IssueComment[]>
  listReviewComments(prNumber: number): Promise<ReviewComment[]>
  listReviews(prNumber: number): Promise<PullRequestReview[]>
  listPullRequestCommits(prNumber: number): Promise<PullRequestCommit[]>
  listReviewThreads(prNumber: number): Promise<ReviewThreadsResult>
  listIssueCommentReactions(commentId: number): Promise<Reaction[]>
  createIssueCommentReaction(commentId: number, content: "eyes"): Promise<void>
  createIssueComment(prNumber: number, body: string): Promise<void>
  submitReview(prNumber: number, headSha: string, payload: ReviewPayload): Promise<void>
  submitReply(prNumber: number, commentId: number, body: string): Promise<void>
}

export function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/", 2)
  if (!owner || !repo) {
    throw new Error("repository must use owner/name format")
  }
  return { owner, repo }
}

/**
 * Gives REST pull requests the same canonical ref fields used by the reviewer.
 * Keeping this compatibility at the API boundary prevents every downstream
 * phase from branching between REST and GraphQL property names.
 */
function normalizePullRequest(data: PullRequestSummary): PullRequestSummary {
  return {
    ...data,
    author: data.author || data.user || null,
    baseRefName: data.baseRefName || data.base?.ref || null,
    headRefName: data.headRefName || data.head?.ref || null,
    baseRefOid: data.baseRefOid || data.base?.sha || null,
    headRefOid: data.headRefOid || data.head?.sha || null,
    isDraft: data.isDraft ?? data.draft ?? false
  }
}

type GraphQLThreadNode = {
  id?: string | null
  isResolved?: boolean | null
  isOutdated?: boolean | null
  path?: string | null
  line?: number | null
  startLine?: number | null
  diffSide?: string | null
  startDiffSide?: string | null
  comments?: {
    nodes?: Array<{
      databaseId?: number | null
      id?: string | null
      body?: string | null
      path?: string | null
      line?: number | null
      startLine?: number | null
      createdAt?: string | null
      url?: string | null
      author?: {
        login?: string | null
      } | null
    }>
  }
}

type GraphQLReviewThreadsResponse = {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        nodes?: GraphQLThreadNode[]
        pageInfo?: {
          hasNextPage?: boolean
          endCursor?: string | null
        }
      }
    } | null
  } | null
}

/**
 * Normalizes GraphQL review-thread nodes into the REST-like shape used by queue
 * validation and action-item discovery.
 */
function normalizeReviewThread(node: GraphQLThreadNode): ReviewThread {
  const comments: ReviewThreadComment[] = (node.comments?.nodes || []).map(comment => ({
    id: comment.databaseId || null,
    node_id: comment.id || null,
    user: {
      login: comment.author?.login || null
    },
    body: comment.body || "",
    path: comment.path || node.path || null,
    line: comment.line || node.line || null,
    start_line: comment.startLine || node.startLine || null,
    side: node.diffSide || "RIGHT",
    start_side: node.startDiffSide || null,
    created_at: comment.createdAt || null,
    html_url: comment.url || null
  }))
  const firstComment = comments[0] || null
  const latestComment = comments[comments.length - 1] || null

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
    comments
  }
}

/**
 * Creates the live Octokit-backed client used for all runner-owned GitHub API
 * reads and writes.
 */
export function createGitHubClient(options: { token: string; repository: string }): GitHubClient {
  const octokit = new Octokit({
    auth: options.token,
    userAgent: "singular-code-review-agent"
  })

  return {
    async getPullRequest(prNumber, repository = options.repository) {
      const { owner, repo } = splitRepository(repository)
      const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: prNumber
      })
      return normalizePullRequest(response.data as PullRequestSummary)
    },

    async getPullRequestDiff(prNumber, repository = options.repository) {
      const { owner, repo } = splitRepository(repository)
      const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: prNumber,
        mediaType: {
          format: "diff"
        }
      })
      return String(response.data || "")
    },

    async getIssue(issueNumber, repository = options.repository) {
      const { owner, repo } = splitRepository(repository)
      const response = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        owner,
        repo,
        issue_number: issueNumber
      })
      return response.data as IssueSummary
    },

    async getCommit(ref, repository = options.repository) {
      const { owner, repo } = splitRepository(repository)
      const response = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner, repo, ref })
      return response.data as RepositoryCommit
    },

    async getIssueComment(commentId) {
      const { owner, repo } = splitRepository(options.repository)
      const response = await octokit.request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
        owner,
        repo,
        comment_id: commentId
      })
      return response.data as IssueComment
    },

    async listIssueComments(issueNumber, repository = options.repository) {
      const { owner, repo } = splitRepository(repository)
      return (await octokit.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100
      })) as IssueComment[]
    },

    async listReviewComments(prNumber) {
      const { owner, repo } = splitRepository(options.repository)
      return (await octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100
      })) as ReviewComment[]
    },

    async listReviews(prNumber) {
      const { owner, repo } = splitRepository(options.repository)
      return (await octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100
      })) as PullRequestReview[]
    },

    async listPullRequestCommits(prNumber) {
      const { owner, repo } = splitRepository(options.repository)
      return (await octokit.paginate("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100
      })) as PullRequestCommit[]
    },

    async listReviewThreads(prNumber) {
      const { owner, repo } = splitRepository(options.repository)
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
}`
      const threads: ReviewThread[] = []
      let cursor: string | null = null

      try {
        for (;;) {
          const response = (await octokit.graphql(query, {
            owner,
            name: repo,
            number: prNumber,
            cursor
          })) as GraphQLReviewThreadsResponse
          const connection = response.repository?.pullRequest?.reviewThreads
          if (!connection || !Array.isArray(connection.nodes)) {
            // Review threads are a quality improvement, not a hard dependency.
            // Validation falls back to flat REST comments when this data is absent.
            return { available: false, threads: [] }
          }

          threads.push(...connection.nodes.map(normalizeReviewThread))
          if (!connection.pageInfo?.hasNextPage) {
            return { available: true, threads }
          }

          cursor = connection.pageInfo.endCursor || null
          if (!cursor) {
            return { available: true, threads }
          }
        }
      } catch {
        // GraphQL thread access can fail for permissions or schema availability.
        // Treat that as unavailable context rather than failing the whole review.
        return { available: false, threads: [] }
      }
    },

    async listIssueCommentReactions(commentId) {
      const { owner, repo } = splitRepository(options.repository)
      return (await octokit.paginate("GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions", {
        owner,
        repo,
        comment_id: commentId,
        per_page: 100
      })) as Reaction[]
    },

    async createIssueCommentReaction(commentId, content) {
      const { owner, repo } = splitRepository(options.repository)
      await octokit.request("POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions", {
        owner,
        repo,
        comment_id: commentId,
        content
      })
    },

    async createIssueComment(prNumber, body) {
      const { owner, repo } = splitRepository(options.repository)
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: prNumber,
        body
      })
    },

    async submitReview(prNumber, headSha, payload) {
      const { owner, repo } = splitRepository(options.repository)
      await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        owner,
        repo,
        pull_number: prNumber,
        commit_id: headSha,
        body: payload.body,
        event: payload.event,
        comments: payload.comments
      })
    },

    async submitReply(prNumber, commentId, body) {
      const { owner, repo } = splitRepository(options.repository)
      await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies", {
        owner,
        repo,
        pull_number: prNumber,
        comment_id: commentId,
        body
      })
    }
  }
}
