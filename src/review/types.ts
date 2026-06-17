export const REVIEW_BOT_LOGIN = "singular-code-review[bot]"
export const REVIEW_COMMAND = "@singular-code-review"

export type ReviewSide = "RIGHT" | "LEFT"

export type InlineCommentKind = "comment" | "suggestion"

export type ReviewInlineCommentInput = {
  kind?: InlineCommentKind
  path: string
  line: number | string
  start_line?: number | string
  side?: ReviewSide | string
  start_side?: ReviewSide | string
  body: string
}

export type ReviewInlineComment = {
  kind: InlineCommentKind
  path: string
  line: number
  start_line?: number
  side: ReviewSide
  start_side?: ReviewSide
  body: string
}

export type ReviewReplyInput = {
  to?: number | string
  comment_id?: number | string
  body: string
}

export type ReviewReply = {
  to: number
  body: string
}

export type DroppedQueueItem = {
  kind: "inline" | "reply"
  item: unknown
  reason: string
}

export type ReviewQueue = {
  version: 1
  inlineComments: ReviewInlineCommentInput[]
  replies: ReviewReplyInput[]
  conclusion: string | null
  dropped: DroppedQueueItem[]
  updatedAt: string
}

export type ValidatedReviewQueue = {
  version: 1
  inlineComments: ReviewInlineComment[]
  replies: ReviewReply[]
  dropped: DroppedQueueItem[]
  stats: {
    queued_inline: number
    queued_replies: number
    has_conclusion: boolean
    valid_inline: number
    valid_replies: number
    dropped: number
  }
  conclusion: string | null
}

export type DiffFile = {
  path: string
  addedLines: number[]
  deletedLines: number[]
  rightLines: number[]
  leftLines: number[]
}

export type ParsedDiff = {
  files: DiffFile[]
}

export type ValidCommentRanges = Record<
  string,
  {
    added_lines: number[]
    deleted_lines: number[]
    right_lines: number[]
    left_lines: number[]
  }
>

export type CompactLineRanges = string[]

export type ModelCommentRanges = Record<
  string,
  {
    added: CompactLineRanges
    deleted: CompactLineRanges
    right: CompactLineRanges
    left: CompactLineRanges
  }
>

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
  html_url?: string | null
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

export type ReviewActionItem =
  | {
      id: string
      kind: "trigger_request" | "mentioned"
      actor: string | null
      body: string
      comment_id: number
      created_at?: string | null
    }
  | {
      id: string
      kind: "reply_requested"
      actor: string | null
      body: string
      reply_to_comment_id: number
      latest_reply_id?: number | null
      review_thread_id?: string | null
      path?: string | null
      line?: number | null
    }

export type ReviewTrigger = {
  event_name: string | null
  reason: "manual" | "mention" | "ready_for_review" | "opened" | "synchronize" | "workflow_dispatch"
  actor: string | null
  trigger_comment: {
    id: number
    user: string | null
    body: string
    html_url: string | null
  } | null
}

export type ReviewContext = {
  generated_at: string
  run: ReviewTrigger & {
    command: string
    bot_login: string
  }
  pr: unknown
  diff: {
    file: string
    files: string[]
    ignored_files: string[]
  }
  valid_comment_ranges: ValidCommentRanges
  issue_comments: IssueComment[]
  review_comments: ReviewComment[]
  review_threads_available: boolean
  review_threads: ReviewThread[]
  unresolved_review_threads: ReviewThread[]
  unresolved_bot_threads: ReviewThread[]
  reviews: PullRequestReview[]
  previous_bot_findings: ReviewComment[]
  action_items: ReviewActionItem[]
}

export type AuditorContext = {
  generated_at: string
  run: ReviewContext["run"]
  pr: {
    number: number | null
    title: string | null
    body: string | null
    author: string | null
    base_ref: string | null
    head_ref: string | null
    base_sha: string | null
    head_sha: string | null
    url: string | null
    is_draft: boolean | null
    review_decision: string | null
    head_repository: string | null
  }
  diff: {
    file: string
    files: string[]
    ignored_files: string[]
  }
  review_threads_available: boolean
  review_seems_complete?: boolean
  previous_bot_findings: Array<{
    id: number
    path: string | null
    line: number | null
    start_line: number | null
    side: string | null
    start_side: string | null
    body: string
    html_url: string | null
    user_login: string | null
    created_at: string | null
  }>
  unresolved_bot_threads: Array<{
    id: string | null
    is_outdated: boolean
    path: string | null
    line: number | null
    start_line: number | null
    side: string | null
    start_side: string | null
    top_level_comment_id: number | null
    top_level_author: string | null
    top_level_body: string
    top_level_html_url: string | null
    latest_author: string | null
    latest_comment_id: number | null
    latest_body: string
    latest_html_url: string | null
  }>
  action_items: ReviewActionItem[]
}

export type ReviewerContext = Omit<AuditorContext, "diff"> & {
  diff: {
    file: string
    files: string[]
    ignored: string[]
    ranges: ModelCommentRanges
  }
  issue_comments: Array<{
    id: number
    user_login: string | null
    body: string
    html_url: string | null
    author_association: string | null
    created_at: string | null
  }>
  recent_reviews: Array<{
    id: number | null
    user_login: string | null
    state: string | null
    body: string
    submitted_at: string | null
    commit_id: string | null
    html_url: string | null
  }>
}

export type GateDecision =
  | {
      decision: "review"
      reason: string
    }
  | {
      decision: "no-review"
      answer: string
    }
  | {
      decision: "answer"
      answer: string
    }

export type GateDeltaMode =
  | "none"
  | "no_previous_review"
  | "same_head"
  | "ancestor_diff"
  | "rebase_compare"
  | "unavailable"

export type GateContext = Pick<
  ReviewerContext,
  "generated_at" | "run" | "pr" | "issue_comments" | "previous_bot_findings" | "unresolved_bot_threads" | "action_items"
> & {
  diff: {
    files: string[]
    ignored: string[]
    current_hash: string | null
  }
  recent_bot_reviews: ReviewerContext["recent_reviews"]
  last_bot_review: ReviewerContext["recent_reviews"][number] | null
  delta: {
    mode: GateDeltaMode
    file: string | null
    summary: string
    last_reviewed_commit: string | null
    current_head: string | null
    changed_files: string[]
    old_patch_id: string | null
    current_patch_id: string | null
    patch_ids_match: boolean | null
  }
}

export type ReviewPayloadComment = {
  path: string
  line: number
  side: ReviewSide
  start_line?: number
  start_side?: ReviewSide
  body: string
}

export type ReviewPayload = {
  body: string
  event: "COMMENT"
  comments: ReviewPayloadComment[]
}
