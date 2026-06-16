import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildArtifactPaths } from "../dist/config/paths.js"
import { ArtifactStore } from "../dist/lib/artifacts.js"
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
        return []
      },
      async listReviews() {
        return options.reviews || []
      },
      async listReviewThreads() {
        return { available: true, threads: [] }
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

test("runner executes review, audit, synthesis, validation, and submission in order", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "runner-pipeline-"))
  fs.mkdirSync(path.join(workspace, ".git"))
  const config = createConfig(workspace)
  const artifacts = new ArtifactStore(config.artifacts)
  const diffText = fs.readFileSync(fixture, "utf8")
  const github = createGitHub(diffText)
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
  assert.deepEqual(reviewerContext.diff.ranges["src/app.js"].added, ["2", "4", "6"])
  assert.deepEqual(reviewerContext.diff.ranges["src/new.js"].added, ["1-2"])
  assert.equal(Object.hasOwn(reviewerContext.diff, "ignored_files"), false)
  const auditorContext = JSON.parse(fs.readFileSync(config.artifacts.auditorContextFile, "utf8"))
  assert.deepEqual(auditorContext.diff.files, ["src/app.js", "src/new.js"])
  assert.equal(Object.hasOwn(auditorContext, "valid_comment_ranges"), false)
  assert.equal(Object.hasOwn(auditorContext, "review_comments"), false)
  assert.equal(auditorContext.review_seems_complete, false)
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
