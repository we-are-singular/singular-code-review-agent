import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildArtifactPaths } from "../dist/config/paths.js"
import { ArtifactStore } from "../dist/lib/artifacts.js"
import { buildReviewContext } from "../dist/review/context.js"
import { addInlineComment, loadQueue, saveQueue } from "../dist/review/queue.js"
import { REVIEW_WORKFLOW_PHASES, runReviewWorkflow } from "../dist/review/workflow.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixture = path.join(repoRoot, "test", "fixtures", "sample.patch")

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {}
  }
}

function createConfig(workspace, dryRun = false) {
  return {
    repository: "owner/repo",
    prNumber: 42,
    githubToken: "token",
    workspace,
    dryRun,
    model: "opencode-go/minimax-m3",
    gateModel: "opencode-go/deepseek-v4-flash",
    command: "@singular-code-review",
    botLogin: "singular-code-review[bot]",
    ignoreHistory: false,
    artifacts: buildArtifactPaths({}, workspace),
    triggerCommentId: null,
    eventName: null,
    eventPath: null,
    actor: null
  }
}

function createGitHub(diffText, options = {}) {
  const submitted = {
    reviews: [],
    replies: [],
    issueComments: []
  }

  return {
    submitted,
    client: {
      async getPullRequest() {
        return {
          number: 42,
          title: "Test PR",
          html_url: "https://github.com/owner/repo/pull/42",
          base: {
            sha: options.baseSha || null
          },
          head: {
            sha: options.headSha || null,
            repo: {
              full_name: "owner/repo",
              forks_url: "https://api.github.com/repos/owner/repo/forks"
            }
          }
        }
      },
      async getPullRequestDiff() {
        return diffText
      },
      async getIssueComment() {
        throw new Error("not used")
      },
      async listIssueComments() {
        return options.issueComments || []
      },
      async listReviewComments() {
        return options.reviewComments || []
      },
      async listReviews() {
        return options.reviews || []
      },
      async listPullRequestCommits() {
        return options.commits || []
      },
      async listReviewThreads() {
        return { available: options.reviewThreadsAvailable !== false, threads: options.reviewThreads || [] }
      },
      async listIssueCommentReactions() {
        return []
      },
      async createIssueCommentReaction() {},
      async createIssueComment(_prNumber, body) {
        submitted.issueComments.push(body)
      },
      async submitReview(_prNumber, payload) {
        submitted.reviews.push(payload)
      },
      async submitReply(_prNumber, commentId, body) {
        submitted.replies.push({ commentId, body })
      }
    }
  }
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
}

function writeFile(repo, file, body) {
  const target = path.join(repo, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, body)
}

function commit(repo, message) {
  git(repo, ["add", "."])
  git(repo, ["commit", "-m", message])
  return git(repo, ["rev-parse", "HEAD"])
}

function createGitWorkspace(prefix = "runner-gate-") {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  git(workspace, ["init"])
  git(workspace, ["config", "user.email", "reviewer@example.com"])
  git(workspace, ["config", "user.name", "Reviewer"])
  writeFile(workspace, "README.md", "base\n")
  const base = commit(workspace, "base")
  git(workspace, ["checkout", "-b", "feature"])
  writeFile(workspace, "src/app.js", "export const value = 1;\n")
  const reviewed = commit(workspace, "reviewed")
  return { workspace, base, reviewed }
}

function writeEventFile(workspace, payload) {
  const file = path.join(workspace, "event.json")
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
  return file
}

function botReview(commitId) {
  return {
    id: 1,
    user: { login: "singular-code-review[bot]" },
    state: "COMMENTED",
    body: "Previous review.",
    submitted_at: "2026-06-15T00:00:00Z",
    commit_id: commitId,
    html_url: "https://github.com/owner/repo/pull/42#pullrequestreview-1"
  }
}

test("review context can ignore live PR history", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "runner-ignore-history-"))
  const diffText = fs.readFileSync(fixture, "utf8")
  const github = createGitHub(diffText, {
    commits: [
      {
        sha: "47138577abc123",
        author: { login: "entomb" },
        parents: [{ sha: "base" }],
        commit: {
          message: "Add timeout guard",
          author: { name: "Joao", date: "2026-06-16T10:00:00Z" },
          committer: { name: "Joao", date: "2026-06-16T10:00:00Z" }
        }
      }
    ]
  }).client

  github.listIssueComments = async () => {
    throw new Error("issue comments should not be fetched")
  }
  github.listReviewComments = async () => {
    throw new Error("review comments should not be fetched")
  }
  github.listReviews = async () => {
    throw new Error("reviews should not be fetched")
  }
  github.listReviewThreads = async () => {
    throw new Error("review threads should not be fetched")
  }

  const context = await buildReviewContext({
    github,
    repository: "owner/repo",
    prNumber: 42,
    diffFile: path.join(workspace, "pr.diff"),
    timelineFile: path.join(workspace, "timeline.json"),
    ignoreHistory: true
  })

  assert.deepEqual(context.issue_comments, [])
  assert.deepEqual(context.review_comments, [])
  assert.deepEqual(context.reviews, [])
  assert.deepEqual(context.review_threads, [])
  assert.deepEqual(context.unresolved_review_threads, [])
  assert.deepEqual(context.unresolved_bot_threads, [])
  assert.deepEqual(context.previous_bot_findings, [])
  assert.deepEqual(context.action_items, [])
  assert.equal(context.review_threads_available, true)
  assert.match(context.pr_timeline.chronological_entries.join("\n"), /4713857 \| commit/u)
})

test("runner executes review, audit, synthesis, validation, and submission in order", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "runner-pipeline-"))
  fs.mkdirSync(path.join(workspace, ".git"))
  const config = createConfig(workspace)
  const artifacts = new ArtifactStore(config.artifacts)
  const diffText = fs.readFileSync(fixture, "utf8")
  const headSha = "47138577abc123"
  const github = createGitHub(diffText, {
    commits: [
      {
        sha: headSha,
        html_url: `https://github.com/owner/repo/commit/${headSha}`,
        author: { login: "entomb" },
        parents: [{ sha: "base" }],
        commit: {
          message: "Add timeout guard\n\nKeep invalid timeouts out of callers.",
          author: { name: "Joao", date: "2026-06-16T10:00:00Z" },
          committer: { name: "Joao", date: "2026-06-16T10:00:00Z" }
        }
      }
    ],
    issueComments: [
      {
        id: 9,
        user: { login: "linear-code[bot]" },
        body: '<!-- linear-linkback --><p><a href="https://linear.app/we-are-singular/issue/SHE-118">SHE-118</a></p>',
        html_url: "https://github.com/owner/repo/pull/42#issuecomment-9",
        author_association: "NONE",
        created_at: "2026-06-16T09:59:00Z"
      },
      {
        id: 10,
        user: { login: "entomb" },
        body: "@singular-code-review can you try again?",
        html_url: "https://github.com/owner/repo/pull/42#issuecomment-10",
        author_association: "MEMBER",
        created_at: "2026-06-16T10:02:00Z"
      }
    ],
    reviews: [botReview(headSha)],
    reviewThreads: [
      {
        id: "thread-1",
        is_resolved: false,
        is_outdated: false,
        path: "src/app.js",
        line: 2,
        start_line: null,
        side: "RIGHT",
        start_side: null,
        top_level_comment_id: 100,
        top_level_author: "singular-code-review[bot]",
        latest_author: "entomb",
        latest_comment_id: 101,
        comments: [
          {
            id: 100,
            node_id: "node-100",
            user: { login: "singular-code-review[bot]" },
            body: "Previous finding.",
            path: "src/app.js",
            line: 2,
            start_line: null,
            side: "RIGHT",
            start_side: null,
            created_at: "2026-06-16T10:01:00Z",
            html_url: "https://github.com/owner/repo/pull/42#discussion_r100"
          },
          {
            id: 101,
            node_id: "node-101",
            user: { login: "entomb" },
            body: "I fixed this in the latest push.",
            path: "src/app.js",
            line: 2,
            start_line: null,
            side: "RIGHT",
            start_side: null,
            created_at: "2026-06-16T10:03:00Z",
            html_url: "https://github.com/owner/repo/pull/42#discussion_r101"
          }
        ]
      }
    ]
  })
  const calls = []

  const opencode = {
    async run(options) {
      calls.push(options)
      if (options.prompt.includes("Review this pull request")) {
        addInlineComment(config.artifacts.queueFile, {
          path: "src/app.js",
          line: 2,
          body: "The timeout can become NaN."
        })
        addInlineComment(config.artifacts.queueFile, {
          path: "src/app.js",
          line: 2,
          body: "The timeout can become NaN."
        })
        return { text: "Queued one finding.", sessionId: "review-session", args: [] }
      }
      if (options.prompt.includes("Audit the queued pull request review comments")) {
        const queue = loadQueue(config.artifacts.queueFile)
        queue.inlineComments = [
          {
            kind: "comment",
            path: "src/app.js",
            line: 2,
            side: "RIGHT",
            body: "Validate the timeout before passing it to callers."
          }
        ]
        saveQueue(config.artifacts.queueFile, queue)
        return { text: "Audit complete.", sessionId: "post-session", args: [] }
      }
      if (options.prompt.includes("Write the final GitHub pull request review body")) {
        assert.equal(options.reuseSession, true)
        return { text: "Request changes: keep the queued finding.", sessionId: "post-session", args: [] }
      }
      throw new Error(`unexpected prompt: ${options.prompt}`)
    }
  }

  const result = await runReviewWorkflow({
    config,
    artifacts,
    github: github.client,
    opencode,
    logger: createLogger()
  })

  assert.equal(result.status, "submitted")
  assert.deepEqual(REVIEW_WORKFLOW_PHASES, ["gathering", "gate", "review", "audit", "synthesis"])
  assert.equal(calls.length, 3)
  assert.equal(calls[0].agent, "reviewer")
  assert.equal(calls[1].agent, "auditor")
  assert.equal(calls[2].agent, "auditor")
  assert.match(calls[0].files[0], /^\/tmp\/\.singular-code-review\/runner-pipeline-/u)
  assert.match(calls[0].files[0], /\/review_model_context\.json$/u)
  assert.match(calls[0].files[1], /^\/tmp\/\.singular-code-review\/runner-pipeline-/u)
  assert.match(calls[0].files[1], /\/pr\.diff$/u)
  assert.match(calls[0].prompt, /\/tmp\/\.singular-code-review\/runner-pipeline-.+\/review_model_context\.json/u)
  assert.match(calls[0].prompt, /\/tmp\/\.singular-code-review\/runner-pipeline-.+\/pr\.diff/u)
  assert.match(calls[1].files[2], /\/audit_model_context\.json$/u)
  assert.match(calls[2].files[2], /\/audit_model_context\.json$/u)
  assert.doesNotMatch(calls[1].prompt, /review_validation_context\.json/u)
  assert.match(calls[1].prompt, /audit_model_context\.json/u)
  assert.match(calls[2].prompt, /audit_model_context\.json/u)
  const reviewerContext = JSON.parse(fs.readFileSync(config.artifacts.reviewerContextFile, "utf8"))
  assert.equal(reviewerContext.pr.title, "Test PR")
  assert.equal(reviewerContext.pr.head_repository, "owner/repo")
  assert.equal(Object.hasOwn(reviewerContext.pr, "forks_url"), false)
  assert.deepEqual(reviewerContext.participants, ["Joao <@entomb>"])
  assert.deepEqual(reviewerContext.diff.ranges["src/app.js"].added, ["2", "4", "6"])
  assert.deepEqual(reviewerContext.diff.ranges["src/new.js"].added, ["1-2"])
  assert.equal(Object.hasOwn(reviewerContext.diff, "ignored_files"), false)
  assert.doesNotMatch(JSON.stringify(reviewerContext), /https?:\/\/|html_url|<!--|<a/u)
  assert.equal(reviewerContext.pr_timeline.full_event_file, config.artifacts.timelineFile)
  assert.equal(reviewerContext.pr_timeline.older_entries_omitted_due_to_long_history, 0)
  assert.match(
    reviewerContext.pr_timeline.chronological_entries.join("\n"),
    /4713857 \| commit \| @entomb \| Add timeout guard/u
  )
  assert.match(
    reviewerContext.pr_timeline.chronological_entries.join("\n"),
    /issue-10 \| issue_comment \| @entomb \| MEMBER \| @singular-code-review can you try again\?/u
  )
  assert.match(
    reviewerContext.pr_timeline.chronological_entries.join("\n"),
    /issue-9 \| issue_comment \| @linear-code\[bot\] \| NONE \| SHE-118/u
  )
  assert.doesNotMatch(reviewerContext.pr_timeline.chronological_entries.join("\n"), /https:\/\/linear\.app|<a|<!--/u)
  assert.match(
    reviewerContext.pr_timeline.chronological_entries.join("\n"),
    /comment-101 \| thread_comment \| @entomb \| unresolved \| src\/app\.js:2 \| I fixed this/u
  )
  const timeline = JSON.parse(fs.readFileSync(config.artifacts.timelineFile, "utf8"))
  assert.equal(timeline.older_entries_omitted_due_to_long_history, 0)
  assert.deepEqual(timeline.chronological_entries, reviewerContext.pr_timeline.chronological_entries)
  assert.doesNotMatch(JSON.stringify(timeline), /https?:\/\/|html_url|<!--|<a/u)
  assert.deepEqual(
    timeline.events.map(event => event.kind),
    ["review", "issue_comment", "commit", "thread_comment", "issue_comment", "thread_comment"]
  )
  assert.equal(timeline.events.find(event => event.comment_id === 101).thread_id, "thread-1")
  const validationContext = JSON.parse(fs.readFileSync(config.artifacts.contextFile, "utf8"))
  assert.deepEqual(Object.keys(validationContext).sort(), [
    "diff",
    "generated_at",
    "review_comments",
    "review_threads_available",
    "run",
    "unresolved_bot_threads"
  ])
  assert.deepEqual(validationContext.diff.files, ["src/app.js", "src/new.js"])
  assert.deepEqual(validationContext.diff.ranges["src/app.js"].added_lines, [2, 4, 6])
  assert.equal(validationContext.review_comments.length, 0)
  assert.deepEqual(validationContext.unresolved_bot_threads, [
    {
      id: "thread-1",
      is_resolved: false,
      is_outdated: false,
      path: "src/app.js",
      line: 2,
      start_line: null,
      side: "RIGHT",
      start_side: null,
      top_level_comment_id: 100,
      top_level_author: "singular-code-review[bot]",
      top_level_body: "Previous finding."
    }
  ])
  assert.doesNotMatch(JSON.stringify(validationContext), /https:\/\/github\.com/u)
  assert.equal(Object.hasOwn(validationContext, "pr"), false)
  assert.equal(Object.hasOwn(validationContext, "issue_comments"), false)
  const auditorContext = JSON.parse(fs.readFileSync(config.artifacts.auditorContextFile, "utf8"))
  assert.deepEqual(auditorContext.diff.files, ["src/app.js", "src/new.js"])
  assert.deepEqual(auditorContext.participants, reviewerContext.participants)
  assert.deepEqual(auditorContext.recent_bot_reviews, [
    {
      id: 1,
      user_login: "singular-code-review[bot]",
      state: "COMMENTED",
      body: "Previous review.",
      submitted_at: "2026-06-15T00:00:00Z",
      commit_id: headSha
    }
  ])
  assert.equal(Object.hasOwn(auditorContext, "valid_comment_ranges"), false)
  assert.equal(Object.hasOwn(auditorContext, "review_comments"), false)
  assert.equal(auditorContext.review_seems_complete, false)
  assert.deepEqual(auditorContext.pr_timeline.chronological_entries, reviewerContext.pr_timeline.chronological_entries)
  assert.deepEqual(github.submitted.reviews, [
    {
      body: "> reviewer · minimax-m3\n\nRequest changes: keep the queued finding.",
      event: "COMMENT",
      comments: [
        {
          path: "src/app.js",
          line: 2,
          side: "RIGHT",
          body: "Validate the timeout before passing it to callers."
        }
      ]
    }
  ])
  assert.equal(JSON.parse(fs.readFileSync(config.artifacts.payloadFile, "utf8")).comments.length, 1)
})

test("runner restores the pre-audit queue when audit writes invalid JSON", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "runner-audit-corrupt-"))
  fs.mkdirSync(path.join(workspace, ".git"))
  const config = createConfig(workspace, true)
  const artifacts = new ArtifactStore(config.artifacts)
  const github = createGitHub(fs.readFileSync(fixture, "utf8"))
  const warnings = []

  const opencode = {
    async run(options) {
      if (options.prompt.includes("Review this pull request")) {
        addInlineComment(config.artifacts.queueFile, {
          path: "src/app.js",
          line: 2,
          body: "The timeout can become NaN."
        })
        return { text: "Request changes: queued one finding.", sessionId: "review-session", args: [] }
      }
      if (options.prompt.includes("Audit the queued pull request review comments")) {
        fs.writeFileSync(
          config.artifacts.queueFile,
          '{"version":1,"inlineComments":[{"path":"src/app.js","line":2,"body":"bad\njson"}]}\n'
        )
        return { text: "Audit complete.", sessionId: "post-session", args: [] }
      }
      if (options.prompt.includes("Write the final GitHub pull request review body")) {
        return { text: "Request changes: keep the restored queue.", sessionId: "post-session", args: [] }
      }
      throw new Error(`unexpected prompt: ${options.prompt}`)
    }
  }

  const result = await runReviewWorkflow({
    config,
    artifacts,
    github: github.client,
    opencode,
    logger: { ...createLogger(), warn: (message, context) => warnings.push({ message, context }) }
  })

  assert.equal(result.status, "dry-run")
  assert.match(warnings[0].message, /post-audit queue validation failed/u)
  assert.deepEqual(github.submitted.reviews[0].comments, [
    {
      path: "src/app.js",
      line: 2,
      side: "RIGHT",
      body: "The timeout can become NaN."
    }
  ])
  assert.equal(loadQueue(config.artifacts.queueFile).inlineComments[0].body, "The timeout can become NaN.")
})

test("runner skips audit when the first pass queues no actions", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "runner-empty-"))
  fs.mkdirSync(path.join(workspace, ".git"))
  const config = createConfig(workspace, true)
  const artifacts = new ArtifactStore(config.artifacts)
  const github = createGitHub(fs.readFileSync(fixture, "utf8"))
  const calls = []

  const opencode = {
    async run(options) {
      calls.push(options.prompt)
      if (options.prompt.includes("Review this pull request")) {
        return { text: "No blocking findings.", sessionId: "review-session", args: [] }
      }
      if (options.prompt.includes("Write the final GitHub pull request review body")) {
        return { text: "LGTM. The change is narrow and safe.", sessionId: "post-session", args: [] }
      }
      throw new Error("audit should not run")
    }
  }

  const result = await runReviewWorkflow({
    config,
    artifacts,
    github: github.client,
    opencode,
    logger: createLogger()
  })

  assert.equal(result.status, "dry-run")
  assert.equal(calls.length, 2)
  assert.match(calls[0], /Review this pull request/u)
  assert.match(calls[1], /Write the final GitHub pull request review body/u)
  assert.equal(JSON.parse(fs.readFileSync(config.artifacts.auditorContextFile, "utf8")).review_seems_complete, true)
  assert.equal(github.submitted.reviews[0].body, "> reviewer · minimax-m3\n\nLGTM. The change is narrow and safe.")
  assert.deepEqual(github.submitted.reviews[0].comments, [])
})

test("runner lets synthesis post an incomplete verdict for unfinished empty reviews", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "runner-interrupted-empty-"))
  fs.mkdirSync(path.join(workspace, ".git"))
  const config = createConfig(workspace, true)
  const artifacts = new ArtifactStore(config.artifacts)
  const github = createGitHub(fs.readFileSync(fixture, "utf8"))
  const calls = []

  const opencode = {
    async run(options) {
      calls.push(options.prompt)
      if (options.prompt.includes("Review this pull request")) {
        return { text: "I'll review the PR. Let me inspect the changed files.", sessionId: "review-session", args: [] }
      }
      if (options.prompt.includes("Write the final GitHub pull request review body")) {
        const auditorContext = JSON.parse(fs.readFileSync(config.artifacts.auditorContextFile, "utf8"))
        assert.equal(auditorContext.review_seems_complete, false)
        return {
          text: "The automated review appears to have stopped before completing its analysis.\n\n## Verdict\n\n❓ Incomplete review: automated reviewer stopped before producing a final conclusion.",
          sessionId: "post-session",
          args: []
        }
      }
      throw new Error("audit should not run for an empty queue")
    }
  }

  const result = await runReviewWorkflow({
    config,
    artifacts,
    github: github.client,
    opencode,
    logger: createLogger()
  })

  assert.equal(result.status, "dry-run")
  assert.equal(calls.length, 2)
  assert.match(github.submitted.reviews[0].body, /❓ Incomplete review: automated reviewer stopped/u)
  assert.deepEqual(github.submitted.replies, [])
})

test("runner keeps an empty synthesis result compact instead of exposing reviewer output", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "runner-empty-synthesis-"))
  fs.mkdirSync(path.join(workspace, ".git"))
  const config = createConfig(workspace, true)
  const artifacts = new ArtifactStore(config.artifacts)
  const github = createGitHub(fs.readFileSync(fixture, "utf8"))
  const reviewerProgress = "I'll inspect one more concern before reaching a verdict. "
  const synthesisCalls = []

  const opencode = {
    async run(options) {
      if (options.prompt.includes("Review this pull request")) {
        return { text: reviewerProgress.repeat(500), sessionId: "review-session", args: [] }
      }
      if (options.prompt.includes("Write the final GitHub pull request review body")) {
        synthesisCalls.push(options)
        return { text: "", sessionId: "post-session", args: [] }
      }
      throw new Error("audit should not run for an empty queue")
    }
  }

  const result = await runReviewWorkflow({
    config,
    artifacts,
    github: github.client,
    opencode,
    logger: createLogger()
  })

  const body = github.submitted.reviews[0].body
  assert.equal(result.status, "dry-run")
  assert.equal(synthesisCalls.length, 2)
  assert.equal(synthesisCalls[0].reuseSession, true)
  assert.equal(synthesisCalls[1].reuseSession, false)
  assert.match(body, /❓ Incomplete review: the final review summary could not be generated\./u)
  assert.doesNotMatch(body, /I'll inspect one more concern/u)
  assert.ok(body.length <= 6_000)
})

test("runner retries an unfinished empty review after an OpenCode permission denial", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "runner-permission-retry-"))
  fs.mkdirSync(path.join(workspace, ".git"))
  const config = createConfig(workspace, true)
  const artifacts = new ArtifactStore(config.artifacts)
  const github = createGitHub(fs.readFileSync(fixture, "utf8"))
  const calls = []
  let reviewAttempts = 0

  const opencode = {
    async run(options) {
      calls.push(options)
      if (options.prompt.includes("Review this pull request")) {
        reviewAttempts += 1
        if (reviewAttempts === 1) {
          fs.writeFileSync(
            options.outputFile,
            [
              "Let me continue reading the rest of the diff and key files.",
              "! permission requested: external_directory (/apps/web/src/lib/server/*); auto-rejecting"
            ].join("\n")
          )
          return { text: "Let me continue reading the rest of the diff and key files.", sessionId: "first", args: [] }
        }

        fs.writeFileSync(options.outputFile, "No blocking findings.\n")
        return { text: "No blocking findings.", sessionId: "second", args: [] }
      }
      if (options.prompt.includes("Write the final GitHub pull request review body")) {
        const auditorContext = JSON.parse(fs.readFileSync(config.artifacts.auditorContextFile, "utf8"))
        assert.equal(auditorContext.review_seems_complete, true)
        return { text: "LGTM. No actionable findings after retry.", sessionId: "post-session", args: [] }
      }
      throw new Error("audit should not run for an empty queue")
    }
  }

  const result = await runReviewWorkflow({
    config,
    artifacts,
    github: github.client,
    opencode,
    logger: createLogger()
  })

  assert.equal(result.status, "dry-run")
  assert.equal(calls.length, 3)
  const reviewCalls = calls.filter(call => call.prompt.includes("Review this pull request"))
  assert.equal(reviewCalls.length, 2)
  assert.equal(reviewCalls[0].prompt, reviewCalls[1].prompt)
  assert.equal(reviewCalls[0].reuseSession, true)
  assert.equal(reviewCalls[1].reuseSession, true)
  assert.equal(github.submitted.reviews[0].body, "> reviewer · minimax-m3\n\nLGTM. No actionable findings after retry.")
  assert.deepEqual(github.submitted.replies, [])
})

test("runner uses gate answer for direct mention questions without submitting a review", async () => {
  const { workspace, base, reviewed } = createGitWorkspace("runner-gate-answer-")
  const config = createConfig(workspace)
  config.eventName = "issue_comment"
  config.eventPath = writeEventFile(workspace, {
    action: "created",
    comment: {
      id: 123,
      body: "@singular-code-review does the previous finding still apply?",
      html_url: "https://github.com/owner/repo/pull/42#issuecomment-123",
      user: { login: "octocat" }
    },
    sender: { login: "octocat" }
  })
  const artifacts = new ArtifactStore(config.artifacts)
  const comment = {
    id: 123,
    body: "@singular-code-review does the previous finding still apply?",
    html_url: "https://github.com/owner/repo/pull/42#issuecomment-123",
    author_association: "MEMBER",
    user: { login: "octocat" }
  }
  const github = createGitHub(fs.readFileSync(fixture, "utf8"), {
    baseSha: base,
    headSha: reviewed,
    issueComments: [comment]
  })
  const calls = []
  const opencode = {
    async run(options) {
      calls.push(options)
      assert.equal(options.agent, "gate")
      assert.equal(options.model, "opencode-go/deepseek-v4-flash")
      return {
        text: '{"decision":"answer","answer":"Yes, the previous finding still applies."}',
        sessionId: "gate-session",
        args: []
      }
    }
  }

  const result = await runReviewWorkflow({
    config,
    artifacts,
    github: github.client,
    opencode,
    logger: createLogger()
  })

  assert.equal(result.status, "answered")
  assert.equal(calls.length, 1)
  assert.deepEqual(github.submitted.issueComments, ["Yes, the previous finding still applies."])
  assert.deepEqual(github.submitted.reviews, [])
  const gateResult = JSON.parse(fs.readFileSync(config.artifacts.gateResultFile, "utf8"))
  assert.equal(typeof gateResult.generated_at, "string")
  assert.deepEqual(gateResult, {
    generated_at: gateResult.generated_at,
    decision: "answer",
    status: "answered",
    answer: "Yes, the previous finding still applies."
  })
})

test("runner posts gate no-review comments with a final LGTM line", async () => {
  const { workspace, base, reviewed } = createGitWorkspace("runner-gate-no-review-")
  const config = createConfig(workspace)
  config.eventName = "pull_request"
  config.eventPath = writeEventFile(workspace, {
    action: "synchronize",
    pull_request: { number: 42 },
    sender: { login: "octocat" }
  })
  const artifacts = new ArtifactStore(config.artifacts)
  const github = createGitHub(fs.readFileSync(fixture, "utf8"), {
    baseSha: base,
    headSha: reviewed,
    reviews: [botReview(reviewed)]
  })
  const opencode = {
    async run() {
      throw new Error("gate no-review should not call OpenCode")
    }
  }

  const result = await runReviewWorkflow({
    config,
    artifacts,
    github: github.client,
    opencode,
    logger: createLogger()
  })

  const expectedAnswer =
    "No full re-review needed: the current head commit already has a completed Singular Code Review.\n\n✅ LGTM"
  assert.equal(result.status, "no-review")
  assert.equal(result.reason, expectedAnswer)
  assert.deepEqual(github.submitted.issueComments, [expectedAnswer])
  assert.deepEqual(github.submitted.reviews, [])
  const gateResult = JSON.parse(fs.readFileSync(config.artifacts.gateResultFile, "utf8"))
  assert.deepEqual(gateResult, {
    generated_at: gateResult.generated_at,
    decision: "no-review",
    status: "no-review",
    answer: expectedAnswer
  })
})

test("runner treats explicit retry mentions as full review requests", async () => {
  const { workspace, base, reviewed } = createGitWorkspace("runner-mention-rereview-")
  const config = createConfig(workspace)
  config.eventName = "issue_comment"
  config.eventPath = writeEventFile(workspace, {
    action: "created",
    comment: {
      id: 123,
      body: "@singular-code-review can you try again?",
      html_url: "https://github.com/owner/repo/pull/42#issuecomment-123",
      user: { login: "octocat" }
    },
    sender: { login: "octocat" }
  })
  const artifacts = new ArtifactStore(config.artifacts)
  const comment = {
    id: 123,
    body: "@singular-code-review can you try again?",
    html_url: "https://github.com/owner/repo/pull/42#issuecomment-123",
    author_association: "MEMBER",
    user: { login: "octocat" }
  }
  const github = createGitHub(fs.readFileSync(fixture, "utf8"), {
    baseSha: base,
    headSha: reviewed,
    issueComments: [comment],
    reviews: [botReview(reviewed)]
  })
  const calls = []
  const opencode = {
    async run(options) {
      calls.push(options)
      assert.notEqual(options.agent, "gate")
      if (options.prompt.includes("Review this pull request")) {
        return { text: "No blocking findings.", sessionId: "review-session", args: [] }
      }
      if (options.prompt.includes("Write the final GitHub pull request review body")) {
        return { text: "LGTM. Re-reviewed the same head.", sessionId: "post-session", args: [] }
      }
      throw new Error(`unexpected prompt: ${options.prompt}`)
    }
  }

  const result = await runReviewWorkflow({
    config,
    artifacts,
    github: github.client,
    opencode,
    logger: createLogger()
  })

  assert.equal(result.status, "submitted")
  assert.deepEqual(
    calls.map(call => call.agent),
    ["reviewer", "auditor"]
  )
  assert.equal(fs.existsSync(config.artifacts.gateResultFile), false)
  assert.deepEqual(github.submitted.issueComments, [])
  assert.equal(github.submitted.reviews[0].body, "> reviewer · minimax-m3\n\nLGTM. Re-reviewed the same head.")
})

test("runner escalates synchronize gate review decisions into the full review pipeline", async () => {
  const { workspace, base, reviewed } = createGitWorkspace("runner-gate-review-")
  writeFile(workspace, "src/app.js", "export const value = 2;\n")
  const head = commit(workspace, "update")
  const config = createConfig(workspace)
  config.eventName = "pull_request"
  config.eventPath = writeEventFile(workspace, {
    action: "synchronize",
    pull_request: { number: 42 },
    sender: { login: "octocat" }
  })
  const artifacts = new ArtifactStore(config.artifacts)
  fs.writeFileSync(
    config.artifacts.gateResultFile,
    `${JSON.stringify({ decision: "no-review", status: "no-review", answer: "stale gate result" }, null, 2)}\n`
  )
  const github = createGitHub(fs.readFileSync(fixture, "utf8"), {
    baseSha: base,
    headSha: head,
    reviews: [botReview(reviewed)]
  })
  const calls = []
  const opencode = {
    async run(options) {
      calls.push(options)
      if (options.prompt.includes("Decide whether Singular Code Review should run")) {
        return {
          text: '{"decision":"review","reason":"The delta changes runtime code."}',
          sessionId: "gate-session",
          args: []
        }
      }
      if (options.prompt.includes("Review this pull request")) {
        return { text: "No blocking findings.", sessionId: "review-session", args: [] }
      }
      if (options.prompt.includes("Write the final GitHub pull request review body")) {
        return { text: "LGTM. The runtime change is safe.", sessionId: "post-session", args: [] }
      }
      throw new Error(`unexpected prompt: ${options.prompt}`)
    }
  }

  const result = await runReviewWorkflow({
    config,
    artifacts,
    github: github.client,
    opencode,
    logger: createLogger()
  })

  assert.equal(result.status, "submitted")
  assert.deepEqual(
    calls.map(call => call.agent),
    ["gate", "reviewer", "auditor"]
  )
  assert.equal(calls[0].model, "opencode-go/deepseek-v4-flash")
  assert.equal(calls[1].model, "opencode-go/minimax-m3")
  assert.match(fs.readFileSync(config.artifacts.gateDeltaFile, "utf8"), /value = 2/u)
  assert.equal(fs.existsSync(config.artifacts.gateResultFile), false)
  assert.equal(github.submitted.reviews[0].body, "> reviewer · minimax-m3\n\nLGTM. The runtime change is safe.")
})

test("dry-run synchronize triggers bypass the gate and run the full review", async () => {
  const { workspace, base, reviewed } = createGitWorkspace("runner-dry-gate-skip-")
  writeFile(workspace, "src/app.js", "export const value = 2;\n")
  const head = commit(workspace, "update")
  const config = createConfig(workspace, true)
  config.eventName = "pull_request"
  config.eventPath = writeEventFile(workspace, {
    action: "synchronize",
    pull_request: { number: 42 },
    sender: { login: "octocat" }
  })
  const artifacts = new ArtifactStore(config.artifacts)
  const github = createGitHub(fs.readFileSync(fixture, "utf8"), {
    baseSha: base,
    headSha: head,
    reviews: [botReview(reviewed)]
  })
  const calls = []
  const opencode = {
    async run(options) {
      calls.push(options)
      assert.notEqual(options.agent, "gate")
      if (options.prompt.includes("Review this pull request")) {
        return { text: "No blocking findings.", sessionId: "review-session", args: [] }
      }
      if (options.prompt.includes("Write the final GitHub pull request review body")) {
        return { text: "LGTM. Dry run exercised the full review path.", sessionId: "post-session", args: [] }
      }
      throw new Error(`unexpected prompt: ${options.prompt}`)
    }
  }

  const result = await runReviewWorkflow({
    config,
    artifacts,
    github: github.client,
    opencode,
    logger: createLogger()
  })

  assert.equal(result.status, "dry-run")
  assert.deepEqual(
    calls.map(call => call.agent),
    ["reviewer", "auditor"]
  )
  assert.equal(fs.existsSync(config.artifacts.gateDeltaFile), false)
  assert.equal(fs.existsSync(config.artifacts.gateResultFile), false)
  assert.equal(
    github.submitted.reviews[0].body,
    "> reviewer · minimax-m3\n\nLGTM. Dry run exercised the full review path."
  )
})
