import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildArtifactPaths } from "../dist/config/paths.js";
import { ArtifactStore } from "../dist/lib/artifacts.js";
import { addInlineComment, loadQueue, saveQueue } from "../dist/review/queue.js";
import { REVIEW_WORKFLOW_PHASES, runReviewWorkflow } from "../dist/review/workflow.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repoRoot, "test", "fixtures", "sample.patch");

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function createConfig(workspace, dryRun = false) {
  return {
    repository: "owner/repo",
    prNumber: 42,
    githubToken: "token",
    workspace,
    dryRun,
    model: "opencode-go/minimax-m3",
    command: "@singular-code-review",
    botLogin: "singular-code-review[bot]",
    artifacts: buildArtifactPaths({}, workspace),
    triggerCommentId: null,
    eventName: null,
    eventPath: null,
    actor: null,
  };
}

function createGitHub(diffText) {
  const submitted = {
    reviews: [],
    replies: [],
  };

  return {
    submitted,
    client: {
      async getPullRequest() {
        return {
          number: 42,
          title: "Test PR",
          html_url: "https://github.com/owner/repo/pull/42",
          head: {
            repo: {
              full_name: "owner/repo",
              forks_url: "https://api.github.com/repos/owner/repo/forks",
            },
          },
        };
      },
      async getPullRequestDiff() {
        return diffText;
      },
      async getIssueComment() {
        throw new Error("not used");
      },
      async listIssueComments() {
        return [];
      },
      async listReviewComments() {
        return [];
      },
      async listReviews() {
        return [];
      },
      async listReviewThreads() {
        return { available: true, threads: [] };
      },
      async listIssueCommentReactions() {
        return [];
      },
      async createIssueCommentReaction() {},
      async submitReview(_prNumber, payload) {
        submitted.reviews.push(payload);
      },
      async submitReply(_prNumber, commentId, body) {
        submitted.replies.push({ commentId, body });
      },
    },
  };
}

test("runner executes review, audit, synthesis, validation, and submission in order", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "runner-pipeline-"));
  fs.mkdirSync(path.join(workspace, ".git"));
  const config = createConfig(workspace);
  const artifacts = new ArtifactStore(config.artifacts);
  const diffText = fs.readFileSync(fixture, "utf8");
  const github = createGitHub(diffText);
  const calls = [];

  const opencode = {
    async run(options) {
      calls.push(options);
      if (options.prompt.includes("Review this pull request")) {
        addInlineComment(config.artifacts.queueFile, {
          path: "src/app.js",
          line: 2,
          body: "The timeout can become NaN.",
        });
        addInlineComment(config.artifacts.queueFile, {
          path: "src/app.js",
          line: 2,
          body: "The timeout can become NaN.",
        });
        return { text: "Queued one finding.", sessionId: "review-session", args: [] };
      }
      if (options.prompt.includes("Audit the queued pull request review comments")) {
        const queue = loadQueue(config.artifacts.queueFile);
        queue.inlineComments = [
          {
            kind: "comment",
            path: "src/app.js",
            line: 2,
            side: "RIGHT",
            body: "Validate the timeout before passing it to callers.",
          },
        ];
        saveQueue(config.artifacts.queueFile, queue);
        return { text: "Audit complete.", sessionId: "post-session", args: [] };
      }
      if (options.prompt.includes("Write the final GitHub pull request review body")) {
        assert.equal(options.reuseSession, true);
        return { text: "Request changes: keep the queued finding.", sessionId: "post-session", args: [] };
      }
      throw new Error(`unexpected prompt: ${options.prompt}`);
    },
  };

  const result = await runReviewWorkflow({
    config,
    artifacts,
    github: github.client,
    opencode,
    logger: createLogger(),
  });

  assert.equal(result.status, "submitted");
  assert.deepEqual(REVIEW_WORKFLOW_PHASES, ["gathering", "review", "audit", "synthesis"]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].agent, "reviewer");
  assert.equal(calls[1].agent, "auditor");
  assert.equal(calls[2].agent, "auditor");
  assert.match(calls[0].files[0], /^\/tmp\/\.singular-code-review\/runner-pipeline-/u);
  assert.match(calls[0].files[0], /\/reviewer_context\.json$/u);
  assert.match(calls[0].files[1], /^\/tmp\/\.singular-code-review\/runner-pipeline-/u);
  assert.match(calls[0].files[1], /\/pr\.diff$/u);
  assert.match(calls[0].prompt, /\/tmp\/\.singular-code-review\/runner-pipeline-.+\/reviewer_context\.json/u);
  assert.match(calls[0].prompt, /\/tmp\/\.singular-code-review\/runner-pipeline-.+\/pr\.diff/u);
  assert.match(calls[1].files[2], /\/review_auditor_context\.json$/u);
  assert.match(calls[2].files[2], /\/review_auditor_context\.json$/u);
  assert.doesNotMatch(calls[1].prompt, /review_context\.json/u);
  assert.match(calls[1].prompt, /review_auditor_context\.json/u);
  assert.match(calls[2].prompt, /review_auditor_context\.json/u);
  const reviewerContext = JSON.parse(fs.readFileSync(config.artifacts.reviewerContextFile, "utf8"));
  assert.equal(reviewerContext.pr.title, "Test PR");
  assert.equal(reviewerContext.pr.head_repository, "owner/repo");
  assert.equal(Object.hasOwn(reviewerContext.pr, "forks_url"), false);
  assert.deepEqual(reviewerContext.diff.commentable_ranges["src/app.js"].added_lines, [
    { start: 2, end: 2 },
    { start: 4, end: 4 },
    { start: 6, end: 6 },
  ]);
  const auditorContext = JSON.parse(fs.readFileSync(config.artifacts.auditorContextFile, "utf8"));
  assert.deepEqual(auditorContext.diff.files, ["src/app.js", "src/new.js"]);
  assert.equal(Object.hasOwn(auditorContext, "valid_comment_ranges"), false);
  assert.equal(Object.hasOwn(auditorContext, "review_comments"), false);
  assert.deepEqual(github.submitted.reviews, [
    {
      body: "> reviewer · minimax-m3\n\nRequest changes: keep the queued finding.",
      event: "COMMENT",
      comments: [
        {
          path: "src/app.js",
          line: 2,
          side: "RIGHT",
          body: "Validate the timeout before passing it to callers.",
        },
      ],
    },
  ]);
  assert.equal(JSON.parse(fs.readFileSync(config.artifacts.payloadFile, "utf8")).comments.length, 1);
});

test("runner skips audit when the first pass queues no actions", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "runner-empty-"));
  fs.mkdirSync(path.join(workspace, ".git"));
  const config = createConfig(workspace, true);
  const artifacts = new ArtifactStore(config.artifacts);
  const github = createGitHub(fs.readFileSync(fixture, "utf8"));
  const calls = [];

  const opencode = {
    async run(options) {
      calls.push(options.prompt);
      if (options.prompt.includes("Review this pull request")) {
        return { text: "No blocking findings.", sessionId: "review-session", args: [] };
      }
      if (options.prompt.includes("Write the final GitHub pull request review body")) {
        return { text: "LGTM. The change is narrow and safe.", sessionId: "post-session", args: [] };
      }
      throw new Error("audit should not run");
    },
  };

  const result = await runReviewWorkflow({
    config,
    artifacts,
    github: github.client,
    opencode,
    logger: createLogger(),
  });

  assert.equal(result.status, "dry-run");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /Review this pull request/u);
  assert.match(calls[1], /Write the final GitHub pull request review body/u);
  assert.equal(github.submitted.reviews[0].body, "> reviewer · minimax-m3\n\nLGTM. The change is narrow and safe.");
  assert.deepEqual(github.submitted.reviews[0].comments, []);
});
