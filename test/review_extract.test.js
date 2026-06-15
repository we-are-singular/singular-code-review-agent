import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildArtifactPaths } from "../dist/config/paths.js";
import { extractReviewArtifacts, renderGitHubStepSummary, writeReviewExtraction } from "../dist/review/extract.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createRuntime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-extract-"));
  const workspace = path.join(dir, "workspace");
  const runtimeDir = path.join(dir, "runtime");
  const home = path.join(dir, "home");
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  const paths = buildArtifactPaths({}, workspace, runtimeDir);

  writeJson(paths.payloadFile, {
    body: "Review Summary\n\nUseful summary.\n\nVerdict\n\n⚠️ Request changes: fix the null guard.",
    event: "COMMENT",
    comments: [
      {
        path: "src/app.js",
        line: 2,
        side: "RIGHT",
        body: "Guard null input.",
      },
    ],
  });
  writeJson(paths.validatedFile, {
    version: 1,
    inlineComments: [],
    replies: [{ to: 123, body: "This still applies." }],
    dropped: [{ kind: "inline", item: { path: "src/old.js" }, reason: "duplicate queued comment" }],
    stats: {
      valid_inline: 1,
      valid_replies: 1,
      dropped: 1,
    },
    conclusion: null,
  });
  fs.writeFileSync(paths.reviewOutputFile, "Queued one finding.\n");
  fs.writeFileSync(paths.auditOutputFile, "Audit complete.\n");
  fs.writeFileSync(paths.synthesisOutputFile, "Final body complete.\n");
  fs.writeFileSync(
    `${paths.reviewOutputFile}.jsonl`,
    [
      JSON.stringify({
        type: "text",
        timestamp: 1781518616000,
        sessionID: "review-session",
        text: "Queued one finding.\n",
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          totalTokens: 140,
          costUsd: 0.001,
        },
      }),
      "",
    ].join("\n"),
  );

  return { dir, workspace, runtimeDir, home, paths };
}

test("extractor builds transcript, final comments JSON, and stats from runtime artifacts", () => {
  const { home, paths } = createRuntime();
  const extraction = extractReviewArtifacts({
    paths,
    generatedAt: "2026-06-15T00:00:00.000Z",
    env: {
      HOME: home,
      OPENCODE_MODEL: "opencode-go/minimax-m3",
      GITHUB_REPOSITORY: "owner/repo",
      PR_NUMBER: "42",
    },
  });
  const written = writeReviewExtraction(extraction, paths);

  assert.equal(fs.existsSync(written.transcriptFile), true);
  assert.equal(fs.existsSync(written.commentsFile), true);
  assert.equal(fs.existsSync(written.statsFile), true);
  assert.match(fs.readFileSync(written.transcriptFile, "utf8"), /Final Review Body/u);
  assert.match(fs.readFileSync(written.transcriptFile, "utf8"), /Guard null input/u);
  assert.deepEqual(JSON.parse(fs.readFileSync(written.commentsFile, "utf8")).replies, [
    { to: 123, body: "This still applies." },
  ]);
  const stats = JSON.parse(fs.readFileSync(written.statsFile, "utf8"));
  assert.equal(stats.model, "opencode-go/minimax-m3");
  assert.equal(stats.totals.inputTokens, 100);
  assert.equal(stats.totals.outputTokens, 40);
  assert.equal(stats.totals.totalTokens, 140);
  assert.equal(stats.totals.costUsd, 0.001);
  assert.equal(stats.phases[0].name, "review");
  assert.equal(stats.phases[0].sessionId, "review-session");
});

test("extractor reads OpenCode step usage, turns, and numeric timestamps", () => {
  const { home, paths } = createRuntime();
  fs.writeFileSync(
    `${paths.reviewOutputFile}.jsonl`,
    [
      JSON.stringify({
        type: "step_start",
        timestamp: 1781518615389,
        sessionID: "review-session",
        part: { type: "step-start" },
      }),
      JSON.stringify({
        type: "text",
        timestamp: 1781518616000,
        sessionID: "review-session",
        part: { type: "text", text: "Inspecting diff." },
      }),
      JSON.stringify({
        type: "step_finish",
        timestamp: 1781518616708,
        sessionID: "review-session",
        part: {
          type: "step-finish",
          tokens: {
            input: 10,
            output: 2,
            total: 12,
          },
          cost: 0.1,
        },
      }),
      JSON.stringify({
        type: "step_finish",
        timestamp: 1781518625000,
        sessionID: "review-session",
        part: {
          type: "step-finish",
          tokens: {
            input: 20,
            output: 5,
            total: 25,
          },
          cost: 0.2,
        },
      }),
      "",
    ].join("\n"),
  );

  const extraction = extractReviewArtifacts({
    paths,
    generatedAt: "2026-06-15T00:00:00.000Z",
    env: {
      HOME: home,
      OPENCODE_MODEL: "opencode-go/minimax-m3",
      GITHUB_REPOSITORY: "owner/repo",
      PR_NUMBER: "42",
    },
  });

  assert.equal(extraction.stats.totals.durationMs, 9611);
  assert.equal(extraction.stats.totals.turns, 2);
  assert.equal(extraction.stats.totals.inputTokens, 30);
  assert.equal(extraction.stats.totals.outputTokens, 7);
  assert.equal(extraction.stats.totals.totalTokens, 37);
  assert.equal(extraction.stats.totals.costUsd, 0.30000000000000004);
  assert.equal(extraction.stats.phases[0].textEvents, 1);
});

test("extractor includes gate-only comments in exports and GitHub summary", () => {
  const { home, paths } = createRuntime();
  writeJson(paths.gateResultFile, {
    generated_at: "2026-06-15T00:00:00.000Z",
    decision: "no-review",
    status: "no-review",
    answer: "No full re-review needed: the latest push only updates docs.",
  });

  const extraction = extractReviewArtifacts({
    paths,
    generatedAt: "2026-06-15T00:00:00.000Z",
    env: {
      HOME: home,
      OPENCODE_MODEL: "opencode-go/minimax-m3",
      GITHUB_REPOSITORY: "owner/repo",
      PR_NUMBER: "42",
    },
  });
  const summary = renderGitHubStepSummary(extraction);

  assert.deepEqual(extraction.comments.gate, {
    generatedAt: "2026-06-15T00:00:00.000Z",
    decision: "no-review",
    status: "no-review",
    answer: "No full re-review needed: the latest push only updates docs.",
  });
  assert.deepEqual(extraction.comments.issueComments, [
    {
      source: "gate",
      decision: "no-review",
      body: "No full re-review needed: the latest push only updates docs.",
    },
  ]);
  assert.match(extraction.transcript, /Gate Decision/u);
  assert.match(extraction.transcript, /Issue Comments/u);
  assert.match(summary, /Gate outcome/u);
  assert.match(summary, /No full re-review needed/u);
  assert.match(summary, /\| Issue comments \| 1 \|/u);
  assert.doesNotMatch(summary, /\| review \|/u);
});

test("review_extract CLI writes outputs and appends GitHub step summary", () => {
  const { runtimeDir, home, paths } = createRuntime();
  const outDir = path.join(path.dirname(runtimeDir), "out");
  const summaryFile = path.join(path.dirname(runtimeDir), "summary.md");
  const output = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, "dist", "cli", "review-extract.js"),
      "--runtime-dir",
      runtimeDir,
      "--out-dir",
      outDir,
      "--stdout",
      "stats",
      "--github-summary",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        GITHUB_STEP_SUMMARY: summaryFile,
        OPENCODE_MODEL: "opencode-go/minimax-m3",
        GITHUB_REPOSITORY: "owner/repo",
        PR_NUMBER: "42",
      },
      encoding: "utf8",
    },
  );

  const stdoutStats = JSON.parse(output);
  assert.equal(stdoutStats.repository, "owner/repo");
  assert.equal(fs.existsSync(path.join(outDir, "review_transcript.md")), true);
  assert.equal(fs.existsSync(path.join(outDir, "review_comments.json")), true);
  assert.equal(fs.existsSync(path.join(outDir, "review_stats.json")), true);
  const summary = fs.readFileSync(summaryFile, "utf8");
  assert.match(summary, /Singular Code Review Telemetry/u);
  assert.match(summary, /Input tokens/u);
  assert.match(summary, /Phase Telemetry/u);
  assert.match(summary, /\| Duration \| 0\.0 s \|/u);
  assert.match(summary, /\| review \| review-session \| 0\.0 s \|/u);
  assert.doesNotMatch(summary, /Extracted Files/u);
  assert.doesNotMatch(summary, /Final Review Body/u);
  assert.doesNotMatch(summary, /Runtime dir/u);
  assert.doesNotMatch(summary, /review_transcript\.md/u);
  assert.doesNotMatch(summary, /\d+ ms/u);
  assert.doesNotMatch(summary, /Useful summary/u);
  assert.equal(fs.existsSync(paths.statsFile), false);
});
