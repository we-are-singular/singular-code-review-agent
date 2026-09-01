import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { AmlRuntime } from "@aml-jsx/sdk"
import { jsx } from "@aml-jsx/sdk/jsx-runtime"

import { ReviewContext } from "../dist/components/review-context.js"
import { ReviewContextPrompt } from "../dist/components/review-context-prompt.js"

function snapshot() {
  return {
    generatedAt: "2026-08-31T00:00:00.000Z",
    trigger: { reason: "manual", actor: null },
    pullRequest: {
      number: 42,
      title: "Keep review context composable",
      body: "Explain the intended change.",
      author: { login: "author" },
      baseRefName: "main",
      headRefName: "feature",
      baseRefOid: "a".repeat(40),
      headRefOid: "b".repeat(40),
      isDraft: false
    },
    commits: [],
    actionItems: [],
    timeline: { olderEntriesOmitted: 0, entries: [] },
    issueComments: [],
    reviews: [],
    reviewThreads: [],
    reviewComments: [],
    diff: { text: "", files: [], ignoredFiles: [] }
  }
}

function materializeContext(t, diff) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "review-context-prompt-"))
  const directory = path.join(workspace, ".singular-code-review")
  fs.mkdirSync(directory)
  fs.writeFileSync(
    path.join(directory, "pr.md"),
    "# Pull request #42: Keep review context composable\n\nExplain the intended change.\n\n## Changed files\n\nsrc/example.ts\n"
  )
  fs.writeFileSync(path.join(directory, "pr.diff"), diff)
  fs.writeFileSync(path.join(directory, "history.md"), "# Pull request history\n\n(No history.)\n")
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
  return workspace
}

async function render(workspace, props) {
  return new AmlRuntime().evaluate(
    jsx(ReviewContext.Provider, {
      value: { github: { request: { workspace } }, snapshot: snapshot() },
      children: jsx(ReviewContextPrompt, props)
    })
  )
}

test("ReviewContextPrompt renders selected materialized files with statistics", async t => {
  const workspace = materializeContext(t, "one two\nthree")
  const output = await render(workspace, { files: true, diff: true, history: true })

  assert.match(
    output,
    /### File: `\.singular-code-review\/pr\.md` — pull-request context and changed files \([\d,]+ characters, [\d,]+ words, [\d,]+ lines\)/u
  )
  assert.match(
    output,
    /Use the PR description, refs, commits, and changed-file inventory as intent and scope evidence/u
  )
  assert.match(output, /The complete contents follow; do not read this path or fetch the same PR data again\./u)
  assert.match(output, /Explain the intended change\./u)
  assert.match(output, /src\/example\.ts/u)
  assert.match(
    output,
    /### File: `\.singular-code-review\/pr\.diff` — pull-request diff \(13 characters, 3 words, 2 lines\)/u
  )
  assert.match(output, /### File: `\.singular-code-review\/history\.md` — pull-request history/u)
  assert.doesNotMatch(output, /Inline|not inlined|at least [\d,]+/u)
})

test("ReviewContextPrompt invalidates a cached file when its metadata changes", async t => {
  const workspace = materializeContext(t, "one two\nthree")
  const historyPath = path.join(workspace, ".singular-code-review", "history.md")

  const first = await render(workspace, { history: true })
  fs.writeFileSync(historyPath, "# Pull request history\n\nA new decision was recorded.\n")
  const second = await render(workspace, { history: true })

  assert.doesNotMatch(first, /A new decision was recorded/u)
  assert.match(second, /A new decision was recorded/u)
})

test("ReviewContextPrompt distinguishes an empty file from an omitted large file", async t => {
  const workspace = materializeContext(t, "")
  const output = await render(workspace, { diff: true })

  assert.match(output, /pull-request diff \(0 characters, 0 words, 0 lines\)/u)
  assert.match(output, /\(Empty\.\)/u)
  assert.doesNotMatch(output, /Read completely before staging findings/u)
})

test("ReviewContextPrompt references materialized files larger than the inline limit", async t => {
  const largeDiff = `${"changed line\n".repeat(4_000)}private-tail-marker`
  const workspace = materializeContext(t, largeDiff)
  const output = await render(workspace, { diff: true })

  assert.match(
    output,
    /### File: `\.singular-code-review\/pr\.diff` — pull-request diff \([\d,]+ characters, [\d,]+ words, 4,001 lines\)/u
  )
  assert.match(output, /Read completely before staging findings\./u)
  assert.doesNotMatch(output, /private-tail-marker/u)
  assert.doesNotMatch(output, /changed-file inventory/u)
  assert.doesNotMatch(output, /pull-request history/u)
  assert.doesNotMatch(output, /not inlined|at least [\d,]+/u)
})
