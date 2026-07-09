import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { readJsonFile, writeJsonFile } from "../lib/json.js"
import { type GitHubClient, type ReviewThreadsResult } from "../clients/github.js"
import { filterReviewDiff, parseUnifiedDiff, validCommentRangesFromDiff } from "./diff.js"
import {
  REVIEW_BOT_LOGIN,
  REVIEW_COMMAND,
  type AuditorContext,
  type CompactLineRanges,
  type IssueComment,
  type ModelCommentRanges,
  type PullRequestCommit,
  type PullRequestReview,
  type ReviewActionItem,
  type ReviewComment,
  type ReviewContext,
  type ReviewTimelineEvent,
  type ReviewValidationContext,
  type ReviewerContext,
  type ReviewThread,
  type ReviewTrigger,
  type ValidCommentRanges
} from "./types.js"

type BuildReviewContextOptions = {
  github: GitHubClient
  repository: string
  prNumber: number
  diffFile: string
  timelineFile?: string
  eventName?: string | null
  eventPath?: string | null
  actor?: string | null
  botLogin?: string
  ignoreHistory?: boolean
}

/**
 * Creates a structurally valid context for local commands that may run before
 * the runner has fetched live PR context.
 */
export function createEmptyReviewContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  const base: ReviewContext = {
    generated_at: new Date().toISOString(),
    run: {
      event_name: null,
      reason: "manual",
      actor: null,
      trigger_comment: null,
      command: REVIEW_COMMAND,
      bot_login: REVIEW_BOT_LOGIN
    },
    pr: {},
    diff: { file: "", files: [], ignored_files: [] },
    valid_comment_ranges: {},
    issue_comments: [],
    review_comments: [],
    review_threads_available: false,
    review_threads: [],
    unresolved_review_threads: [],
    unresolved_bot_threads: [],
    reviews: [],
    pr_commits: [],
    pr_timeline: {
      full_event_file: "",
      older_entries_omitted_due_to_long_history: 0,
      chronological_entries: []
    },
    previous_bot_findings: [],
    action_items: []
  }

  return {
    ...base,
    ...overrides,
    run: {
      ...base.run,
      ...overrides.run
    },
    diff: {
      ...base.diff,
      ...overrides.diff
    },
    pr_timeline: {
      ...base.pr_timeline,
      ...(overrides.pr_timeline || {})
    }
  }
}

function readEventPayload(eventPath?: string | null): Record<string, unknown> {
  if (!eventPath || !existsSync(eventPath)) {
    return {}
  }

  return readJsonFile<Record<string, unknown>>(eventPath, {})
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

const TIMELINE_SUMMARY_CHARS = 140
const TIMELINE_CONTEXT_ENTRIES = 60
const MODEL_TEXT_CHARS = 1600

function compactText(value: unknown, max = TIMELINE_SUMMARY_CHARS): string {
  const text = String(value || "")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/<a\b[^>]*>(.*?)<\/a>/giu, "$1")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
  if (text.length <= max) {
    return text
  }
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`
}

function shortSha(value: string | null | undefined): string | null {
  return value ? value.slice(0, 7) : null
}

function actorLogin(user: { login?: string | null } | null | undefined): string | null {
  return user?.login || null
}

function isHumanLogin(login: string | null | undefined, botLogin: string): login is string {
  const normalized = login?.toLowerCase()
  const normalizedBot = botLogin.toLowerCase()
  const normalizedBotBase = normalizedBot.endsWith("[bot]") ? normalizedBot.slice(0, -"[bot]".length) : normalizedBot

  if (!normalized || normalized === normalizedBot || normalized === normalizedBotBase) {
    return false
  }
  return !/\[bot\]$/u.test(normalized)
}

function atMillis(value: string | null | undefined): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function location(
  path: string | null | undefined,
  start: number | null | undefined,
  end: number | null | undefined
): string | null {
  if (!path) {
    return null
  }
  if (start && end && start !== end) {
    return `${path}:${start}-${end}`
  }
  const line = end || start
  return line ? `${path}:${line}` : path
}

function timelineEntry(event: ReviewTimelineEvent): string {
  const fields = [
    event.at || "unknown-time",
    event.ref || event.id,
    event.kind,
    event.actor ? `@${event.actor}` : null,
    event.state || null,
    event.location || null,
    event.summary
  ].filter((value): value is string => Boolean(value))
  return fields.join(" | ")
}

function sortTimelineEvents(events: ReviewTimelineEvent[]): ReviewTimelineEvent[] {
  return events.slice().sort((left, right) => {
    const leftTime = atMillis(left.at) ?? Number.MAX_SAFE_INTEGER
    const rightTime = atMillis(right.at) ?? Number.MAX_SAFE_INTEGER
    if (leftTime !== rightTime) {
      return leftTime - rightTime
    }
    return left.id.localeCompare(right.id)
  })
}

function buildReviewTimeline(options: {
  commits: PullRequestCommit[]
  issueComments: IssueComment[]
  reviewComments: ReviewComment[]
  reviews: PullRequestReview[]
  reviewThreads: ReviewThread[]
  reviewThreadsAvailable: boolean
}): {
  events: ReviewTimelineEvent[]
  older_entries_omitted_due_to_long_history: number
  chronological_entries: string[]
} {
  const events: ReviewTimelineEvent[] = []

  for (const commit of options.commits || []) {
    const sha = commit.sha || null
    const title = compactText(String(commit.commit?.message || "").split(/\r?\n/u)[0] || sha || "commit")
    const isMerge = Boolean((commit.parents || []).length > 1 || /^merge\b/iu.test(title))
    events.push({
      id: `commit:${sha || events.length}`,
      kind: isMerge ? "merge" : "commit",
      at: commit.commit?.committer?.date || commit.commit?.author?.date || null,
      actor: actorLogin(commit.author) || actorLogin(commit.committer),
      ref: shortSha(sha),
      summary: title,
      commit_id: sha
    })
  }

  for (const review of options.reviews || []) {
    const id = numberValue(review.id)
    events.push({
      id: `review:${id ?? events.length}`,
      kind: "review",
      at: stringValue(review.submitted_at) || stringValue(review.submittedAt),
      actor: actorLogin(review.user),
      ref: id ? `review-${id}` : shortSha(review.commit_id || review.commitId),
      state: stringValue(review.state),
      summary: compactText(review.body || "(no review body)"),
      commit_id: stringValue(review.commit_id) || stringValue(review.commitId),
      review_id: id
    })
  }

  for (const comment of options.issueComments || []) {
    events.push({
      id: `issue-comment:${comment.id}`,
      kind: "issue_comment",
      at: comment.created_at || comment.updated_at || null,
      actor: actorLogin(comment.user),
      ref: `issue-${comment.id}`,
      state: comment.author_association || null,
      summary: compactText(comment.body || "(empty comment)"),
      comment_id: comment.id
    })
  }

  if (options.reviewThreadsAvailable) {
    for (const thread of options.reviewThreads || []) {
      const threadState = thread.is_resolved ? "resolved" : thread.is_outdated ? "outdated" : "unresolved"
      for (const comment of thread.comments || []) {
        events.push({
          id: `thread-comment:${thread.id || "unknown"}:${comment.id ?? events.length}`,
          kind: "thread_comment",
          at: comment.created_at,
          actor: actorLogin(comment.user),
          ref: comment.id ? `comment-${comment.id}` : thread.id,
          state: threadState,
          location: location(comment.path || thread.path, comment.start_line, comment.line),
          summary: compactText(comment.body || "(empty thread comment)"),
          comment_id: comment.id,
          thread_id: thread.id
        })
      }
    }
  } else {
    for (const comment of options.reviewComments || []) {
      events.push({
        id: `review-comment:${comment.id}`,
        kind: "review_comment",
        at: comment.created_at || comment.updated_at || null,
        actor: actorLogin(comment.user),
        ref: `comment-${comment.id}`,
        state: comment.in_reply_to_id ? "reply" : "comment",
        location: location(comment.path, comment.start_line || comment.startLine, comment.line),
        summary: compactText(comment.body || "(empty review comment)"),
        review_id: comment.pull_request_review_id || null,
        comment_id: comment.id
      })
    }
  }

  const sorted = sortTimelineEvents(events)
  const olderEntriesOmitted = Math.max(0, sorted.length - TIMELINE_CONTEXT_ENTRIES)
  const visible = sorted.slice(-TIMELINE_CONTEXT_ENTRIES)
  return {
    events: sorted,
    older_entries_omitted_due_to_long_history: olderEntriesOmitted,
    chronological_entries: visible.map(timelineEntry)
  }
}

/**
 * Reads GitHub Actions event metadata into the narrow trigger shape consumed by
 * prompts and review tools.
 */
export function readEventContext(options: {
  eventName?: string | null
  eventPath?: string | null
  actor?: string | null
}): ReviewTrigger {
  const eventName = options.eventName || null
  const payload = readEventPayload(options.eventPath)
  const comment = asRecord(payload.comment)
  const commentUser = asRecord(comment.user)
  const action = stringValue(payload.action)

  const triggerComment =
    numberValue(comment.id) !== null
      ? {
          id: numberValue(comment.id) as number,
          user: stringValue(commentUser.login),
          body: compactText(comment.body, MODEL_TEXT_CHARS)
        }
      : null

  let reason: ReviewTrigger["reason"] = "manual"
  if (eventName === "issue_comment") {
    reason = "mention"
  } else if (eventName === "pull_request" && action === "ready_for_review") {
    reason = "ready_for_review"
  } else if (eventName === "pull_request" && action === "opened") {
    reason = "opened"
  } else if (eventName === "pull_request" && action === "synchronize") {
    reason = "synchronize"
  } else if (eventName === "workflow_dispatch") {
    reason = "workflow_dispatch"
  }

  return {
    event_name: eventName,
    reason,
    actor: options.actor || stringValue(asRecord(payload.sender).login),
    trigger_comment: triggerComment
  }
}

function containsMention(body: unknown, botLogin: string, command: string): boolean {
  const text = String(body || "").toLowerCase()
  const needles = [command, botLogin ? `@${botLogin}` : null].filter(Boolean).map(value => String(value).toLowerCase())
  return needles.some(needle => text.includes(needle))
}

function latestBotActivityMs(options: {
  issueComments: IssueComment[]
  reviews: PullRequestReview[]
  botLogin: string
}): number | null {
  let latest: number | null = null
  const record = (value: string | null | undefined) => {
    const parsed = atMillis(value)
    if (parsed !== null && (latest === null || parsed > latest)) {
      latest = parsed
    }
  }

  for (const comment of options.issueComments || []) {
    if (comment.user?.login === options.botLogin) {
      record(comment.created_at || comment.updated_at)
    }
  }

  for (const review of options.reviews || []) {
    if (review.user?.login === options.botLogin) {
      record(review.submitted_at || review.submittedAt)
    }
  }

  return latest
}

function commentIsAfterLatestBotActivity(comment: IssueComment, latestBotActivity: number | null): boolean {
  if (latestBotActivity === null) {
    return true
  }

  const commentTime = atMillis(comment.created_at || comment.updated_at)
  return commentTime === null || commentTime > latestBotActivity
}

/**
 * Converts mentions and existing review-thread activity into explicit work the
 * reviewer should answer before or during the review.
 */
export function buildActionItems(options: {
  trigger: ReviewTrigger
  issueComments: IssueComment[]
  reviewComments: ReviewComment[]
  reviewThreads: ReviewThread[]
  reviewThreadsAvailable: boolean
  reviews: PullRequestReview[]
  botLogin: string
  command: string
}): ReviewActionItem[] {
  const actionItems: ReviewActionItem[] = []
  const latestBotActivity = latestBotActivityMs({
    issueComments: options.issueComments,
    reviews: options.reviews,
    botLogin: options.botLogin
  })

  if (options.trigger.trigger_comment) {
    actionItems.push({
      id: `issue-comment:${options.trigger.trigger_comment.id}`,
      kind: "trigger_request",
      actor: options.trigger.trigger_comment.user,
      body: compactText(options.trigger.trigger_comment.body, MODEL_TEXT_CHARS),
      comment_id: options.trigger.trigger_comment.id
    })
  }

  for (const comment of options.issueComments || []) {
    if (
      options.trigger.trigger_comment?.id === comment.id ||
      comment.user?.login === options.botLogin ||
      !containsMention(comment.body, options.botLogin, options.command) ||
      !commentIsAfterLatestBotActivity(comment, latestBotActivity)
    ) {
      continue
    }

    actionItems.push({
      id: `issue-comment:${comment.id}`,
      kind: "mentioned",
      actor: comment.user?.login || null,
      body: compactText(comment.body, MODEL_TEXT_CHARS),
      comment_id: comment.id,
      created_at: comment.created_at || null
    })
  }

  if (options.botLogin && options.reviewThreadsAvailable) {
    // GraphQL review-thread state is authoritative when available because it
    // exposes resolution status and thread grouping. The REST fallback below
    // only sees flat review comments.
    for (const thread of options.reviewThreads || []) {
      if (
        thread.is_resolved ||
        thread.top_level_author !== options.botLogin ||
        thread.latest_author === options.botLogin
      ) {
        continue
      }

      if (thread.top_level_comment_id) {
        actionItems.push({
          id: `review-thread:${thread.id}`,
          kind: "reply_requested",
          actor: thread.latest_author,
          body: compactText(thread.comments[thread.comments.length - 1]?.body, MODEL_TEXT_CHARS),
          reply_to_comment_id: Number(thread.top_level_comment_id),
          latest_reply_id: thread.latest_comment_id,
          review_thread_id: thread.id,
          path: thread.path,
          line: thread.line
        })
      }
    }
    return actionItems
  }

  if (!options.botLogin) {
    return actionItems
  }

  const byParent = new Map<number, ReviewComment[]>()
  for (const comment of options.reviewComments || []) {
    const parentId = comment.in_reply_to_id || comment.id
    if (!byParent.has(parentId)) {
      byParent.set(parentId, [])
    }
    byParent.get(parentId)?.push(comment)
  }

  for (const [parentId, comments] of byParent.entries()) {
    const topLevel = comments.find(comment => Number(comment.id) === Number(parentId))
    if (!topLevel || topLevel.user?.login !== options.botLogin) {
      continue
    }

    const sorted = comments
      .slice()
      .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime())
    const latest = sorted[sorted.length - 1]
    if (latest?.user?.login && latest.user.login !== options.botLogin) {
      actionItems.push({
        id: `review-comment:${parentId}`,
        kind: "reply_requested",
        actor: latest.user.login,
        body: compactText(latest.body, MODEL_TEXT_CHARS),
        reply_to_comment_id: Number(parentId),
        latest_reply_id: latest.id
      })
    }
  }

  return actionItems
}

function compactPullRequest(value: unknown): AuditorContext["pr"] {
  const record = asRecord(value)
  const user = asRecord(record.user)
  const author = asRecord(record.author)
  const base = asRecord(record.base)
  const head = asRecord(record.head)
  const headRepo = asRecord(head.repo)

  return {
    number: numberValue(record.number),
    title: stringValue(record.title),
    body: stringValue(record.body) ? compactText(record.body, MODEL_TEXT_CHARS) : null,
    author: stringValue(author.login) || stringValue(user.login),
    base_ref: stringValue(record.baseRefName) || stringValue(base.ref),
    head_ref: stringValue(record.headRefName) || stringValue(head.ref),
    base_sha: stringValue(record.baseRefOid) || stringValue(base.sha),
    head_sha: stringValue(record.headRefOid) || stringValue(head.sha),
    is_draft: booleanValue(record.isDraft) ?? booleanValue(record.draft),
    review_decision: stringValue(record.reviewDecision),
    head_repository: stringValue(headRepo.full_name)
  }
}

function addParticipant(
  participants: Map<string, string>,
  input: {
    login?: string | null
    name?: string | null
  },
  botLogin: string
): void {
  if (!isHumanLogin(input.login, botLogin)) {
    return
  }

  const login = input.login
  const key = login.toLowerCase()
  const mention = `@${login}`
  const unnamed = `<${mention}>`
  const formatted = input.name && input.name.toLowerCase() !== key ? `${input.name} <${mention}>` : unnamed
  const existing = participants.get(key)

  if (existing && (existing !== unnamed || formatted === unnamed)) {
    return
  }

  participants.set(key, formatted)
}

function buildParticipants(context: ReviewContext): string[] {
  const participants = new Map<string, string>()
  const botLogin = context.run.bot_login
  const pr = asRecord(context.pr)
  const author = asRecord(pr.author)
  const user = asRecord(pr.user)

  addParticipant(participants, { login: context.run.actor }, botLogin)
  addParticipant(participants, { login: context.run.trigger_comment?.user }, botLogin)
  addParticipant(participants, { login: stringValue(author.login) || stringValue(user.login) }, botLogin)

  for (const commit of context.pr_commits || []) {
    addParticipant(
      participants,
      { login: actorLogin(commit.author), name: stringValue(commit.commit?.author?.name) },
      botLogin
    )
    addParticipant(
      participants,
      {
        login: actorLogin(commit.committer),
        name: stringValue(commit.commit?.committer?.name)
      },
      botLogin
    )
  }

  for (const comment of context.issue_comments || []) {
    addParticipant(participants, { login: actorLogin(comment.user) }, botLogin)
  }

  for (const review of context.reviews || []) {
    addParticipant(participants, { login: actorLogin(review.user) }, botLogin)
  }

  if (context.review_threads_available) {
    for (const thread of context.review_threads || []) {
      addParticipant(participants, { login: thread.top_level_author }, botLogin)
      addParticipant(participants, { login: thread.latest_author }, botLogin)
      for (const comment of thread.comments || []) {
        addParticipant(participants, { login: actorLogin(comment.user) }, botLogin)
      }
    }
  } else {
    for (const comment of context.review_comments || []) {
      addParticipant(participants, { login: actorLogin(comment.user) }, botLogin)
    }
  }

  for (const item of context.action_items || []) {
    addParticipant(participants, { login: item.actor }, botLogin)
  }

  return [...participants.values()]
}

function compactReviewComment(comment: ReviewComment): AuditorContext["previous_bot_findings"][number] {
  return {
    id: comment.id,
    path: comment.path || null,
    line: comment.line || null,
    start_line: comment.start_line || comment.startLine || null,
    side: comment.side || null,
    start_side: comment.start_side || comment.startSide || null,
    body: compactText(comment.body, MODEL_TEXT_CHARS),
    user_login: comment.user?.login || null,
    created_at: comment.created_at || null
  }
}

function compactReviewThread(thread: ReviewThread): AuditorContext["unresolved_bot_threads"][number] {
  const topLevel = thread.comments[0] || null
  const latest = thread.comments[thread.comments.length - 1] || null

  return {
    id: thread.id,
    is_outdated: thread.is_outdated,
    path: thread.path || topLevel?.path || null,
    line: thread.line || topLevel?.line || null,
    start_line: thread.start_line || topLevel?.start_line || null,
    side: thread.side || topLevel?.side || null,
    start_side: thread.start_side || topLevel?.start_side || null,
    top_level_comment_id: thread.top_level_comment_id,
    top_level_author: thread.top_level_author,
    top_level_body: compactText(topLevel?.body, MODEL_TEXT_CHARS),
    latest_author: thread.latest_author,
    latest_comment_id: thread.latest_comment_id,
    latest_body: compactText(latest?.body, MODEL_TEXT_CHARS)
  }
}

function validationReviewComment(comment: ReviewComment): ReviewValidationContext["review_comments"][number] {
  return {
    id: comment.id,
    path: comment.path || null,
    line: comment.line || null,
    start_line: comment.start_line || comment.startLine || null,
    side: comment.side || null,
    start_side: comment.start_side || comment.startSide || null,
    in_reply_to_id: comment.in_reply_to_id || null,
    user_login: comment.user?.login || null,
    body: comment.body || ""
  }
}

function validationReviewThread(thread: ReviewThread): ReviewValidationContext["unresolved_bot_threads"][number] {
  const topLevel = thread.comments[0] || null

  return {
    id: thread.id,
    is_resolved: thread.is_resolved,
    is_outdated: thread.is_outdated,
    path: thread.path || topLevel?.path || null,
    line: thread.line || topLevel?.line || null,
    start_line: thread.start_line || topLevel?.start_line || null,
    side: thread.side || topLevel?.side || null,
    start_side: thread.start_side || topLevel?.start_side || null,
    top_level_comment_id: thread.top_level_comment_id,
    top_level_author: thread.top_level_author,
    top_level_body: topLevel?.body || ""
  }
}

function numberRanges(lines: number[] | undefined): CompactLineRanges {
  const sorted = Array.from(new Set(lines || [])).sort((a, b) => a - b)
  const ranges: CompactLineRanges = []
  let start: number | null = null
  let end: number | null = null

  const pushCurrent = () => {
    if (start === null || end === null) {
      return
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`)
  }

  for (const line of sorted) {
    if (start === null || end === null) {
      start = line
      end = line
    } else if (line === end + 1) {
      end = line
    } else {
      pushCurrent()
      start = line
      end = line
    }
  }
  pushCurrent()

  return ranges
}

function compactCommentRanges(ranges: ValidCommentRanges): ModelCommentRanges {
  return Object.fromEntries(
    Object.entries(ranges).map(([file, value]) => [
      file,
      {
        added: numberRanges(value.added_lines),
        deleted: numberRanges(value.deleted_lines),
        right: numberRanges(value.right_lines),
        left: numberRanges(value.left_lines)
      }
    ])
  )
}

function compactIssueComment(comment: IssueComment): ReviewerContext["issue_comments"][number] {
  return {
    id: comment.id,
    user_login: comment.user?.login || null,
    body: compactText(comment.body, MODEL_TEXT_CHARS),
    author_association: comment.author_association || null,
    created_at: comment.created_at || null
  }
}

function compactReview(value: unknown): ReviewerContext["recent_reviews"][number] {
  const record = asRecord(value)
  const user = asRecord(record.user)

  return {
    id: numberValue(record.id),
    user_login: stringValue(user.login),
    state: stringValue(record.state),
    body: compactText(record.body, MODEL_TEXT_CHARS),
    submitted_at: stringValue(record.submitted_at) || stringValue(record.submittedAt),
    commit_id: stringValue(record.commit_id) || stringValue(record.commitId)
  }
}

/**
 * Builds the compact context attached to audit and synthesis model runs. The
 * deterministic validator keeps the full context in-process; the auditor only
 * needs PR metadata, trigger/action state, changed file names, and bot history.
 */
export function buildAuditorContext(context: ReviewContext): AuditorContext {
  return {
    generated_at: context.generated_at,
    run: context.run,
    pr: compactPullRequest(context.pr),
    diff: {
      file: context.diff.file,
      files: Array.isArray(context.diff.files) ? context.diff.files : [],
      ignored_files: Array.isArray(context.diff.ignored_files) ? context.diff.ignored_files : []
    },
    review_threads_available: context.review_threads_available,
    participants: buildParticipants(context),
    pr_timeline: context.pr_timeline,
    recent_bot_reviews: (context.reviews || [])
      .map(compactReview)
      .filter(review => review.user_login === context.run.bot_login),
    previous_bot_findings: (context.previous_bot_findings || []).map(compactReviewComment),
    unresolved_bot_threads: (context.unresolved_bot_threads || []).map(compactReviewThread),
    action_items: context.action_items || []
  }
}

/**
 * Builds the tool-only validation context consumed by `review_comments`.
 * It intentionally excludes raw GitHub payloads, URLs, reactions, labels, and
 * other fields that are noisy or irrelevant to deterministic queue checks.
 */
export function buildValidationContext(context: ReviewContext): ReviewValidationContext {
  return {
    generated_at: context.generated_at,
    run: {
      bot_login: context.run.bot_login
    },
    diff: {
      file: context.diff.file,
      files: Array.isArray(context.diff.files) ? context.diff.files : [],
      ignored: Array.isArray(context.diff.ignored_files) ? context.diff.ignored_files : [],
      ranges: context.valid_comment_ranges || {}
    },
    review_threads_available: context.review_threads_available,
    unresolved_bot_threads: (context.unresolved_bot_threads || []).map(validationReviewThread),
    review_comments: (context.review_comments || []).map(validationReviewComment)
  }
}

/**
 * Builds the compact context attached to the reviewer model. Full REST payloads
 * and exact validation arrays stay in the validation context for tools; the LLM
 * gets only author-facing PR metadata, relevant discussion state, changed file
 * names, and compressed line ranges.
 */
export function buildReviewerContext(context: ReviewContext): ReviewerContext {
  const auditorContext = buildAuditorContext(context)

  return {
    ...auditorContext,
    diff: {
      file: auditorContext.diff.file,
      files: auditorContext.diff.files,
      ignored: auditorContext.diff.ignored_files,
      ranges: compactCommentRanges(context.valid_comment_ranges || {})
    },
    issue_comments: (context.issue_comments || []).map(compactIssueComment),
    recent_reviews: (context.reviews || []).map(compactReview)
  }
}

/**
 * Builds the full validation context artifact used by deterministic
 * validation and local troubleshooting. The reviewer model receives the
 * serialized `buildReviewerContext` projection instead.
 */
export async function buildReviewContext(options: BuildReviewContextOptions): Promise<ReviewContext> {
  const botLogin = options.botLogin || REVIEW_BOT_LOGIN
  const command = REVIEW_COMMAND
  const trigger = readEventContext({
    eventName: options.eventName,
    eventPath: options.eventPath,
    actor: options.actor
  })

  const rawDiffText = await options.github.getPullRequestDiff(options.prNumber)
  const filteredDiff = filterReviewDiff(rawDiffText)
  const diffText = filteredDiff.text
  mkdirSync(dirname(options.diffFile), { recursive: true })
  writeFileSync(options.diffFile, diffText, { mode: 0o600 })

  const [pr, commits] = await Promise.all([
    options.github.getPullRequest(options.prNumber),
    options.github.listPullRequestCommits(options.prNumber)
  ])

  // Skip PR history when evaluating or debugging a fresh-review run.
  const [issueComments, reviewComments, reviews, reviewThreadsResult]: [
    IssueComment[],
    ReviewComment[],
    PullRequestReview[],
    ReviewThreadsResult
  ] = options.ignoreHistory
    ? [[], [], [], { available: true, threads: [] }]
    : await Promise.all([
        options.github.listIssueComments(options.prNumber),
        options.github.listReviewComments(options.prNumber),
        options.github.listReviews(options.prNumber),
        options.github.listReviewThreads(options.prNumber)
      ])
  const reviewThreads = reviewThreadsResult.threads
  const unresolvedReviewThreads = reviewThreads.filter(thread => !thread.is_resolved)
  const unresolvedBotThreads = unresolvedReviewThreads.filter(thread => thread.top_level_author === botLogin)
  const timeline = buildReviewTimeline({
    commits,
    issueComments,
    reviewComments,
    reviews,
    reviewThreads,
    reviewThreadsAvailable: reviewThreadsResult.available
  })
  const timelineFile = options.timelineFile || ""
  const generatedAt = new Date().toISOString()
  if (timelineFile) {
    writeJsonFile(timelineFile, {
      generated_at: generatedAt,
      older_entries_omitted_due_to_long_history: timeline.older_entries_omitted_due_to_long_history,
      chronological_entries: timeline.chronological_entries,
      events: timeline.events
    })
  }

  return {
    generated_at: generatedAt,
    run: {
      ...trigger,
      command,
      bot_login: botLogin
    },
    pr,
    pr_commits: commits,
    diff: {
      file: options.diffFile,
      ignored_files: filteredDiff.ignoredFiles,
      files: parseUnifiedDiff(diffText).files.map(file => file.path)
    },
    valid_comment_ranges: validCommentRangesFromDiff(diffText),
    issue_comments: issueComments,
    review_comments: reviewComments,
    review_threads_available: reviewThreadsResult.available,
    review_threads: reviewThreads,
    unresolved_review_threads: unresolvedReviewThreads,
    unresolved_bot_threads: unresolvedBotThreads,
    reviews,
    pr_timeline: {
      full_event_file: timelineFile,
      older_entries_omitted_due_to_long_history: timeline.older_entries_omitted_due_to_long_history,
      chronological_entries: timeline.chronological_entries
    },
    previous_bot_findings: reviewComments.filter(
      comment => comment.user?.login === botLogin && !comment.in_reply_to_id
    ),
    action_items: buildActionItems({
      trigger,
      issueComments,
      reviewComments,
      reviewThreads,
      reviewThreadsAvailable: reviewThreadsResult.available,
      reviews,
      botLogin,
      command
    })
  }
}
