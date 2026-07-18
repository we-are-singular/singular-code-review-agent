import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  buildOpenCodeArgs,
  createCliOpenCodeClient,
  findSessionId,
  textFromJsonEvent
} from "../dist/clients/opencode.js"
import { buildAuditPrompt, buildGatePrompt, buildReviewPrompt, buildSynthesisPrompt } from "../dist/prompts/prompts.js"

function makeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 })
}

test("extracts text and session ids from OpenCode JSON events", () => {
  assert.equal(findSessionId({ event: { part: { sessionID: "ses_123" } } }), "ses_123")
  assert.equal(textFromJsonEvent({ type: "text", text: "Review body" }), "Review body")
  assert.equal(textFromJsonEvent({ event: { part: { type: "text", text: "Nested text" } } }), "Nested text")
})

test("builds modern OpenCode args with explicit file attachments and session reuse", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-args-"))
  const sessionFile = path.join(dir, "session.txt")
  fs.writeFileSync(sessionFile, "ses_456\n")

  const args = buildOpenCodeArgs(
    {
      workspace: "/repo",
      outputFile: "/tmp/out.log",
      agent: "reviewer",
      sessionFile,
      reuseSession: true,
      files: ["/tmp/context.json", "/tmp/pr.diff"],
      prompt: "Review this"
    },
    { run: true, formatJson: true, file: true, session: true }
  )

  assert.deepEqual(args.slice(0, 7), ["run", "--agent", "reviewer", "--format", "json", "--session", "ses_456"])
  assert(args.includes("/tmp/context.json"))
  assert(args.includes("/tmp/pr.diff"))
  assert.equal(args.at(-2), "--")
  assert.equal(args.at(-1), "Review this")
})

test("CLI-backed OpenCode client renders JSON text and stores raw JSONL", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-client-"))
  const mockbin = path.join(dir, "mockbin")
  fs.mkdirSync(mockbin)
  makeExecutable(
    path.join(mockbin, "opencode"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "run" && "\${2:-}" == "--help" ]]; then
  printf '%s\\n' '--format' '--file' '--session'
  exit 0
fi
printf '{"type":"text","sessionID":"ses_789","text":"Rendered review.\\\\n"}\\n'
`
  )

  const oldPath = process.env.PATH
  process.env.PATH = `${mockbin}:${oldPath}`
  try {
    const client = createCliOpenCodeClient()
    const outputFile = path.join(dir, "opencode.log")
    const jsonOutputFile = path.join(dir, "opencode.log.jsonl")
    const sessionFile = path.join(dir, "session.txt")
    const result = await client.run({
      workspace: dir,
      outputFile,
      jsonOutputFile,
      capabilitiesFile: path.join(dir, "capabilities.json"),
      sessionFile,
      agent: "reviewer",
      files: [path.join(dir, "context.json")],
      prompt: "Review this"
    })

    assert.equal(result.text, "Rendered review.\n")
    assert.equal(result.sessionId, "ses_789")
    assert.equal(fs.readFileSync(outputFile, "utf8"), "Rendered review.\n")
    assert.match(fs.readFileSync(jsonOutputFile, "utf8"), /"sessionID":"ses_789"/)
    assert.equal(fs.readFileSync(sessionFile, "utf8").trim(), "ses_789")
  } finally {
    process.env.PATH = oldPath
  }
})

test("CLI-backed OpenCode client preserves a session after a failed permission-denied run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-client-failure-"))
  const mockbin = path.join(dir, "mockbin")
  fs.mkdirSync(mockbin)
  makeExecutable(
    path.join(mockbin, "opencode"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "run" && "\${2:-}" == "--help" ]]; then
  printf '%s\\n' '--format' '--file' '--session'
  exit 0
fi
printf '{"type":"text","sessionID":"ses_denied","text":"! permission requested: external_directory (/tmp); auto-rejecting"}\\n'
exit 1
`
  )

  const oldPath = process.env.PATH
  process.env.PATH = `${mockbin}:${oldPath}`
  try {
    const client = createCliOpenCodeClient()
    const outputFile = path.join(dir, "opencode.log")
    const sessionFile = path.join(dir, "session.txt")

    await assert.rejects(
      client.run({
        workspace: dir,
        outputFile,
        capabilitiesFile: path.join(dir, "capabilities.json"),
        sessionFile,
        agent: "reviewer",
        prompt: "Review this"
      }),
      /opencode exited with status 1/u
    )

    assert.equal(fs.readFileSync(sessionFile, "utf8").trim(), "ses_denied")
    assert.match(fs.readFileSync(outputFile, "utf8"), /permission requested/u)
  } finally {
    process.env.PATH = oldPath
  }
})

test("audit and synthesis prompts stay phase-specific because auditor owns post-processing scope", () => {
  const gatePrompt = buildGatePrompt({
    contextFile: "gate_context.json",
    deltaFile: "delta.diff"
  })
  const reviewPrompt = buildReviewPrompt({
    contextFile: "review_model_context.json",
    diffFile: "pr.diff"
  })
  const resumedReviewPrompt = buildReviewPrompt({
    contextFile: "review_model_context.json",
    diffFile: "pr.diff",
    resumeInstruction: "Resume the prior review."
  })
  const auditPrompt = buildAuditPrompt({
    workspace: "/repo",
    queueFile: "/tmp/.singular-code-review/run/review_queue.json",
    validatedFile: "/tmp/.singular-code-review/run/review_validated.json",
    auditorContextFile: "/tmp/.singular-code-review/run/audit_model_context.json",
    reviewerOutputFile: "/tmp/.singular-code-review/run/opencode_review.log"
  })
  const synthesisPrompt = buildSynthesisPrompt({
    reviewerOutputFile: "opencode_review.log",
    validatedFile: "review_validated.json",
    auditorContextFile: "audit_model_context.json"
  })

  assert.doesNotMatch(auditPrompt, /^You are running a Singular Code Review post-processing phase\./u)
  assert.match(gatePrompt, /pr_timeline\.chronological_entries/u)
  assert.match(gatePrompt, /participants.+formatted as `Name <@username>`/u)
  assert.match(gatePrompt, /Never invent an `@handle` from a real name/u)
  assert.match(gatePrompt, /without backticks or code formatting/u)
  assert.match(gatePrompt, /runner appends the final `✅ LGTM` line/u)
  assert.match(reviewPrompt, /pr_timeline\.chronological_entries/u)
  assert.match(reviewPrompt, /phase inputs and PR-history hints/u)
  assert.match(reviewPrompt, /Treat changed-file paths as repository-relative/u)
  assert.match(reviewPrompt, /leading slash means filesystem root/u)
  assert.match(reviewPrompt, /Runtime artifact paths.+may be absolute/u)
  assert.match(reviewPrompt, /queue the inline comment before relying on it in terminal output/u)
  assert.match(reviewPrompt, /Do not queue a final conclusion/u)
  assert.match(reviewPrompt, /For re-reviews, keep terminal output delta-focused/u)
  assert.doesNotMatch(reviewPrompt, /Resume the prior review\./u)
  assert.match(resumedReviewPrompt, /Resume the prior review\./u)
  assert.doesNotMatch(reviewPrompt, /participants.+formatted as `Name <@username>`/u)
  assert.doesNotMatch(reviewPrompt, /review_comments add/u)
  assert.match(auditPrompt, /Audit the queued pull request review comments/u)
  assert.match(auditPrompt, /expect long or complex inline comments/u)
  assert.match(auditPrompt, /leave short or self-contained comments as they are/u)
  assert.match(auditPrompt, /literal line breaks inside the string/u)
  assert.match(auditPrompt, /verify it still parses as JSON/u)
  assert.match(auditPrompt, /Preserve valid, clearly labeled nonblocking inline comments/u)
  assert.doesNotMatch(synthesisPrompt, /^You are running a Singular Code Review post-processing phase\./u)
  assert.match(synthesisPrompt, /Write the final GitHub pull request review body/u)
  assert.match(synthesisPrompt, /pr_timeline\.chronological_entries/u)
  assert.match(synthesisPrompt, /participants.+formatted as `Name <@username>`/u)
  assert.match(synthesisPrompt, /without backticks or code formatting/u)
  assert.match(synthesisPrompt, /recent_bot_reviews/u)
  assert.match(synthesisPrompt, /For a routine follow-up, use one concise delta-focused paragraph/u)
  assert.match(synthesisPrompt, /`## Verdict`: the final section and final line of the body/u)
  assert.match(synthesisPrompt, /Do not narrate the review run/u)
  assert.match(synthesisPrompt, /reviewer output is evidence, not a draft/u)
  assert.match(synthesisPrompt, /around 120–200 words/u)
  assert.match(synthesisPrompt, /Give each idea one home/u)
  assert.match(synthesisPrompt, /exactly one paragraph of two or three sentences and at most 80 words/u)
  assert.match(synthesisPrompt, /Each bullet should stay under about 25 words/u)
  assert.match(synthesisPrompt, /Shape example \(illustrative wording only\)/u)
  assert.match(synthesisPrompt, /Never turn `Recommendations` into a compressed findings list/u)
  assert.match(synthesisPrompt, /Do not state the number of comments/u)
  assert.match(synthesisPrompt, /do not by themselves justify requesting changes/u)
  assert.match(synthesisPrompt, /Do not emit XML-like tags/u)
  assert.match(synthesisPrompt, /final line of the body/u)
  assert.match(synthesisPrompt, /Do not expose runner internals/u)
  assert.match(synthesisPrompt, /has_conclusion/u)
  assert.match(synthesisPrompt, /review_seems_complete/u)
  assert.match(synthesisPrompt, /Ignore isolated permission denials/u)
  assert.match(synthesisPrompt, /plain user-facing caveat/u)
  assert.match(synthesisPrompt, /✅ LGTM\./u)
  assert.match(synthesisPrompt, /⚠️ Request changes/u)
  assert.match(synthesisPrompt, /⛔ Block/u)
  assert.match(synthesisPrompt, /❓ Incomplete review/u)
})
