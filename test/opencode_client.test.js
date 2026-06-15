import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildOpenCodeArgs, createCliOpenCodeClient, findSessionId, textFromJsonEvent } from "../dist/clients/opencode.js";
import { buildAuditPrompt, buildSynthesisPrompt } from "../dist/prompts/prompts.js";

function makeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

test("extracts text and session ids from OpenCode JSON events", () => {
  assert.equal(findSessionId({ event: { part: { sessionID: "ses_123" } } }), "ses_123");
  assert.equal(textFromJsonEvent({ type: "text", text: "Review body" }), "Review body");
  assert.equal(textFromJsonEvent({ event: { part: { type: "text", text: "Nested text" } } }), "Nested text");
});

test("builds modern OpenCode args with explicit file attachments and session reuse", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-args-"));
  const sessionFile = path.join(dir, "session.txt");
  fs.writeFileSync(sessionFile, "ses_456\n");

  const args = buildOpenCodeArgs(
    {
      workspace: "/repo",
      outputFile: "/tmp/out.log",
      agent: "reviewer",
      sessionFile,
      reuseSession: true,
      files: ["/tmp/context.json", "/tmp/pr.diff"],
      prompt: "Review this",
    },
    { run: true, formatJson: true, file: true, session: true },
  );

  assert.deepEqual(args.slice(0, 7), ["run", "--agent", "reviewer", "--format", "json", "--session", "ses_456"]);
  assert(args.includes("/tmp/context.json"));
  assert(args.includes("/tmp/pr.diff"));
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), "Review this");
});

test("CLI-backed OpenCode client renders JSON text and stores raw JSONL", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-client-"));
  const mockbin = path.join(dir, "mockbin");
  fs.mkdirSync(mockbin);
  makeExecutable(
    path.join(mockbin, "opencode"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "run" && "\${2:-}" == "--help" ]]; then
  printf '%s\\n' '--format' '--file' '--session'
  exit 0
fi
printf '{"type":"text","sessionID":"ses_789","text":"Rendered review.\\\\n"}\\n'
`,
  );

  const oldPath = process.env.PATH;
  process.env.PATH = `${mockbin}:${oldPath}`;
  try {
    const client = createCliOpenCodeClient();
    const outputFile = path.join(dir, "opencode.log");
    const jsonOutputFile = path.join(dir, "opencode.log.jsonl");
    const sessionFile = path.join(dir, "session.txt");
    const result = await client.run({
      workspace: dir,
      outputFile,
      jsonOutputFile,
      capabilitiesFile: path.join(dir, "capabilities.json"),
      sessionFile,
      agent: "reviewer",
      files: [path.join(dir, "context.json")],
      prompt: "Review this",
    });

    assert.equal(result.text, "Rendered review.\n");
    assert.equal(result.sessionId, "ses_789");
    assert.equal(fs.readFileSync(outputFile, "utf8"), "Rendered review.\n");
    assert.match(fs.readFileSync(jsonOutputFile, "utf8"), /"sessionID":"ses_789"/);
    assert.equal(fs.readFileSync(sessionFile, "utf8").trim(), "ses_789");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("audit and synthesis prompts stay phase-specific because auditor owns post-processing scope", () => {
  const auditPrompt = buildAuditPrompt({
    workspace: "/repo",
    queueFile: "/tmp/.singular-code-review/run/review_queue.json",
    validatedFile: "/tmp/.singular-code-review/run/review_validated.json",
    auditorContextFile: "/tmp/.singular-code-review/run/review_auditor_context.json",
    reviewerOutputFile: "/tmp/.singular-code-review/run/opencode_review.log",
  });
  const synthesisPrompt = buildSynthesisPrompt({
    reviewerOutputFile: "opencode_review.log",
    validatedFile: "review_validated.json",
    auditorContextFile: "review_auditor_context.json",
  });

  assert.doesNotMatch(auditPrompt, /^You are running a Singular Code Review post-processing phase\./u);
  assert.match(auditPrompt, /Audit the queued pull request review comments/u);
  assert.doesNotMatch(synthesisPrompt, /^You are running a Singular Code Review post-processing phase\./u);
  assert.match(synthesisPrompt, /Write the final GitHub pull request review body/u);
  assert.match(synthesisPrompt, /Always end with a `Verdict` section/u);
  assert.match(synthesisPrompt, /Do not expose runner internals/u);
  assert.match(synthesisPrompt, /has_conclusion/u);
  assert.match(synthesisPrompt, /Ignore isolated permission denials/u);
  assert.match(synthesisPrompt, /plain user-facing caveat/u);
  assert.match(synthesisPrompt, /✅ LGTM\./u);
  assert.match(synthesisPrompt, /⚠️ Request changes/u);
  assert.match(synthesisPrompt, /⛔ Block/u);
});
