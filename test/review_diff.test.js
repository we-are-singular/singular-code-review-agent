import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ReviewDiff, countDiffLines, containsDiffRange } from "../dist/lib/review-diff.js"
import { ReviewQueue } from "../dist/lib/review-queue.js"
import { createGitHubReadTools } from "../dist/tools/github-read.js"
import { GitHubReviewSession } from "../dist/services/github/session.js"
import { serializePullRequestContext } from "../dist/services/github/context-serializer.js"
import { renderPullRequestContext } from "../dist/lib/render/review-context.js"

test("inclusive ranges preserve sparse anchors, multiline gaps, churn counts, and compact snapshots", () => {
  const diff = ReviewDiff.from(`diff --git a/source.ts b/source.ts
--- a/source.ts
+++ b/source.ts
@@ -1,3 +1,4 @@
 context
-old
+first
+second
 context
@@ -100,2 +101,2 @@
 context
-old
+third
`)
  assert.deepEqual(diff.files[0].addedLines, [
    [2, 3],
    [102, 102]
  ])
  assert.deepEqual(diff.files[0].deletedLines, [
    [2, 2],
    [101, 101]
  ])
  assert.deepEqual(diff.files[0].rightLines, [
    [1, 4],
    [101, 102]
  ])
  assert.equal(countDiffLines(diff.files[0].addedLines), 3)
  assert.equal(containsDiffRange(diff.files[0].rightLines, 1, 3), true)
  assert.equal(containsDiffRange(diff.files[0].rightLines, 4, 102), false)
  const context = { commits: [], history: { olderEntriesOmitted: 0, entries: [] }, issues: [], pullRequests: [] }
  assert.deepEqual(serializePullRequestContext(context, diff).files, ["M source.ts +3 -2"])
  const snapshot = {
    context: { ...context, number: 42, description: "" },
    diff,
    participants: [],
    trigger: { reason: "manual" }
  }
  assert.match(renderPullRequestContext(snapshot), /M source\.ts \+3 -2/u)
  const restored = JSON.parse(JSON.stringify(diff))
  assert.deepEqual(restored.commentRanges["source.ts"].added_lines, [
    [2, 3],
    [102, 102]
  ])
  const queue = new ReviewQueue({
    botLogin: "review-bot",
    commentRanges: restored.commentRanges,
    reviewThreadsAvailable: false,
    unresolvedBotThreads: [],
    reviewComments: []
  })
  const finding = {
    kind: "inline",
    severity: "low",
    body: "Range validation.",
    evidence: "Changed source.",
    confidence: "high",
    path: "source.ts",
    side: "RIGHT"
  }
  assert.doesNotThrow(() => queue.add("intent-contract", { ...finding, start_line: 1, line: 3 }))
  assert.doesNotThrow(() => queue.add("intent-contract", { ...finding, line: 101, side: "LEFT" }))
  assert.throws(
    () => queue.add("intent-contract", { ...finding, start_line: 4, line: 102 }),
    /multi-line range is not fully present/u
  )
  assert.throws(() => queue.add("intent-contract", { ...finding, line: 100 }), /not a changed RIGHT-side line/u)
})

test("out-of-order repeated blocks retain the same anchors as a line-set oracle", () => {
  let seed = 42
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
  for (let trial = 0; trial < 12; trial += 1) {
    const expected = new Set()
    let raw = ""
    for (let hunk = 0; hunk < 30; hunk += 1) {
      const start = 1 + (random() % 100)
      const count = 1 + (random() % 10)
      raw += `diff --git a/source.ts b/source.ts\n--- a/source.ts\n+++ b/source.ts\n@@ -${start},${count} +${start},${count} @@\n`
      for (let line = start; line < start + count; line += 1) {
        raw += "-old\n+new\n"
        expected.add(line)
      }
    }
    const sorted = [...expected].sort((a, b) => a - b)
    const diff = ReviewDiff.from(raw)
    for (const ranges of Object.values(diff.commentRanges["source.ts"])) {
      const expanded = ranges.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, i) => start + i))
      assert.deepEqual(expanded, sorted)
      assert.equal(countDiffLines(ranges), expected.size)
      for (let line = 1; line < 115; line += 1) assert.equal(containsDiffRange(ranges, line), expected.has(line))
    }
  }
})

test("line iteration preserves filtered text for LF, CRLF, omitted blocks, and missing final newlines", () => {
  const raw = "diff --git a/source.ts b/source.ts\n--- a/source.ts\n+++ b/source.ts\n@@ -1 +1 @@\n-old\n+new"
  const lock = "diff --git a/yarn.lock b/yarn.lock\n--- a/yarn.lock\n+++ b/yarn.lock\n@@ -1 +1 @@\n-old\n+new"
  for (const [body, expected] of [
    [raw, raw],
    [`${raw}\n`, `${raw}\n\n`],
    [`${raw}\n${lock}\n`, `${raw}\n`],
    [`${lock}\n${raw}\n`, `${raw}\n\n`]
  ]) {
    for (const text of [body, body.replaceAll("\n", "\r\n")]) {
      const diff = ReviewDiff.from(text)
      assert.match(diff.text, /\+new/u)
      assert.doesNotMatch(diff.text, /\r|yarn\.lock/u)
      assert.equal(diff.text, expected)
    }
  }
})

test("header-like hunk content neither changes paths nor hides source as a lockfile", () => {
  const diff = ReviewDiff.from(`diff --git a/source.sql b/source.sql
--- a/source.sql
+++ b/source.sql
@@ -1,2 +1,2 @@
--- pnpm-lock.yaml
-old value
+++ package-lock.json
+new value
`)
  assert.deepEqual(diff.ignoredFiles, [])
  assert.deepEqual(
    diff.files.map(file => file.path),
    ["source.sql"]
  )
  assert.deepEqual(diff.commentRanges["source.sql"], {
    added_lines: [[1, 2]],
    deleted_lines: [[1, 2]],
    right_lines: [[1, 2]],
    left_lines: [[1, 2]]
  })
})

function repository(t, deletedLines = 9_998, activePrefix = "") {
  const workspace = mkdtempSync(join(tmpdir(), "review-deleted-diff-"))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" })
  const commit = () => {
    git("add", "--", "retired.ts", "active.ts", "renamed-before.ts", "deleted.bin")
    git(
      "-c",
      "user.name=Review Test",
      "-c",
      "user.email=review@example.test",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-qm",
      "base"
    )
  }
  git("init", "-q")
  git("config", "core.hooksPath", "/dev/null")
  git("config", "diff.suppressBlankEmpty", "false")
  // Deleted SQL comments start with --- in a patch, but are hunk content, not file headers.
  const deletedContent = Array.from({ length: deletedLines }, (_, i) => `-- retired line ${i + 1}\n`).join("")
  writeFileSync(join(workspace, "retired.ts"), deletedContent)
  writeFileSync(join(workspace, "active.ts"), `${activePrefix}export const active = false\n`)
  writeFileSync(join(workspace, "renamed-before.ts"), "export const moved = true\n")
  writeFileSync(join(workspace, "deleted.bin"), Buffer.from([0, 1, 2]))
  commit()
  const mergeBase = git("rev-parse", "HEAD").trim()
  rmSync(join(workspace, "retired.ts"))
  rmSync(join(workspace, "deleted.bin"))
  renameSync(join(workspace, "renamed-before.ts"), join(workspace, "renamed-after.ts"))
  writeFileSync(join(workspace, "active.ts"), `${activePrefix}export const active = true\n`)
  writeFileSync(join(workspace, "added.ts"), "export const added = true\n")
  git("add", "--", "retired.ts", "active.ts", "added.ts", "renamed-before.ts", "renamed-after.ts", "deleted.bin")
  git(
    "-c",
    "user.name=Review Test",
    "-c",
    "user.email=review@example.test",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-qm",
    "head"
  )
  const head = git("rev-parse", "HEAD").trim()

  // Advance the target independently so base..head would include an unrelated deletion.
  git("checkout", "-q", "--detach", mergeBase)
  writeFileSync(join(workspace, "base-only.ts"), "export const unrelated = true\n")
  git("add", "--", "base-only.ts")
  git(
    "-c",
    "user.name=Review Test",
    "-c",
    "user.email=review@example.test",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-qm",
    "base advanced"
  )
  const base = git("rev-parse", "HEAD").trim()
  git("checkout", "-q", "--detach", head)
  const raw = git("diff", "--find-renames", `${base}...${head}`)
  const pullRequest = { number: 42, baseRefOid: base, headRefOid: head, additions: 2, deletions: deletedLines + 1 }
  const request = {
    repository: "owner/repo",
    prNumber: 42,
    workspace,
    workspaceHeadSha: head,
    botLogin: "review-bot",
    eventName: null,
    eventPath: null,
    actor: null,
    ignoreHistory: false
  }
  return { workspace, git, mergeBase, deletedContent, pullRequest, request, raw }
}

for (const changes of [9_999, 10_000, 10_001]) {
  test(`PR with ${changes} changed lines ${changes > 10_000 ? "compacts" : "retains"} deleted contents`, async t => {
    const fixture = repository(t, changes - 3)
    let diffCalls = 0
    let metadataCalls = 0
    const session = new GitHubReviewSession(
      {
        async getPullRequest() {
          metadataCalls += 1
          return fixture.pullRequest
        },
        async getPullRequestDiff() {
          diffCalls += 1
          return fixture.raw
        }
      },
      fixture.request
    )

    // Neither working-tree edits nor target-only commits belong in the frozen PR diff.
    writeFileSync(join(fixture.workspace, "active.ts"), "working-tree-only-marker\n")
    const [first, second] = await Promise.all([session.getPullRequestDiff(), session.getPullRequestDiff()])
    assert.strictEqual(first, second)
    assert.equal(await createGitHubReadTools(session).getPullRequestDiff.execute({ pull_number: 42 }), first.text)
    assert.equal(metadataCalls, 1)
    assert.equal(diffCalls, changes > 10_000 ? 0 : 1)
    const full = ReviewDiff.from(fixture.raw)
    assert.deepEqual(first.files, full.files)
    assert.deepEqual(first.commentRanges, full.commentRanges)
    assert.equal(countDiffLines(first.files.find(file => file.path === "retired.ts").deletedLines), changes - 3)
    assert.deepEqual(first.ignoredFiles, ["deleted.bin"])
    assert.doesNotMatch(first.text, /deleted\.bin/u)
    assert.match(first.text, /deleted file mode 100644/u)
    assert.match(first.text, /-export const active = false/u)
    assert.match(first.text, /\+export const active = true/u)
    assert.match(first.text, /rename to renamed-after\.ts/u)
    assert.doesNotMatch(first.text, /working-tree-only-marker|base-only\.ts/u)

    if (changes > 10_000) {
      assert.doesNotMatch(first.text, /retired line/u)
      const compact = fixture.git(
        "diff",
        "--find-renames",
        "-D",
        `${fixture.pullRequest.baseRefOid}...${fixture.pullRequest.headRefOid}`,
        "--",
        ":(exclude)deleted.bin"
      )
      assert.equal(first.text, ReviewDiff.from(compact).text)
      assert.equal(fixture.git("show", `${fixture.mergeBase}:retired.ts`), fixture.deletedContent)
      const queue = new ReviewQueue({
        botLogin: "review-bot",
        commentRanges: first.commentRanges,
        reviewThreadsAvailable: false,
        unresolvedBotThreads: [],
        reviewComments: []
      })
      const finding = {
        kind: "inline",
        severity: "high",
        body: "The removed behavior still has a caller.",
        evidence: "The old implementation remains inspectable through git show.",
        confidence: "high",
        path: "retired.ts",
        line: changes - 3,
        side: "LEFT"
      }
      assert.doesNotThrow(() => queue.add("code-path-bug-hunter", finding))
      assert.throws(
        () => queue.add("code-path-bug-hunter", { ...finding, line: changes }),
        /not a changed LEFT-side line/u
      )
    } else {
      assert.equal(first.text, full.text)
      assert.match(first.text, /retired line/u)
    }
  })
}

for (const deletedLines of [2, 9_998]) {
  const compact = deletedLines === 9_998
  test(`local Git preserves blank-context anchors ${compact ? "for large PRs" : "after GitHub 406"}`, async t => {
    const fixture = repository(t, deletedLines, "// retained context\n\n")
    const model = compact
      ? fixture.git(
          "diff",
          "--find-renames",
          "-D",
          `${fixture.pullRequest.baseRefOid}...${fixture.pullRequest.headRefOid}`
        )
      : undefined
    const expected = ReviewDiff.from(fixture.raw, model)
    fixture.git("config", "diff.suppressBlankEmpty", "true")
    const session = new GitHubReviewSession(
      {
        async getPullRequest() {
          return fixture.pullRequest
        },
        async getPullRequestDiff() {
          throw Object.assign(new Error("diff too large"), { status: 406 })
        }
      },
      fixture.request
    )
    const diff = await session.getPullRequestDiff()
    assert.deepEqual(diff.commentRanges["active.ts"].added_lines, [[3, 3]])
    assert.deepEqual(diff.commentRanges, expected.commentRanges)
    assert.equal(diff.text, expected.text)
    const queue = new ReviewQueue({
      botLogin: "review-bot",
      commentRanges: diff.commentRanges,
      reviewThreadsAvailable: false,
      unresolvedBotThreads: [],
      reviewComments: []
    })
    const finding = {
      kind: "inline",
      severity: "low",
      body: "The changed line follows blank context.",
      evidence: "The complete patch retains the blank line.",
      confidence: "high",
      path: "active.ts",
      side: "RIGHT",
      line: 3,
      start_line: 1
    }
    assert.doesNotThrow(() => queue.add("code-path-bug-hunter", finding))
    assert.throws(() => queue.add("code-path-bug-hunter", { ...finding, line: 2 }), /not a changed RIGHT-side line/u)
  })
}

test("GitHub 406 falls back to the complete local diff without compacting a small PR", async t => {
  const fixture = repository(t, 2)
  const session = new GitHubReviewSession(
    {
      async getPullRequest() {
        return fixture.pullRequest
      },
      async getPullRequestDiff() {
        throw Object.assign(new Error("diff too large"), { status: 406 })
      }
    },
    fixture.request
  )
  assert.equal((await session.getPullRequestDiff()).text, ReviewDiff.from(fixture.raw).text)
})

test("unrelated PRs never use the active checkout and ordinary GitHub failures propagate", async t => {
  const fixture = repository(t, 2)
  const failure = Object.assign(new Error("GitHub failure"), { status: 406 })
  const calls = []
  const session = new GitHubReviewSession(
    {
      async getPullRequest() {
        return fixture.pullRequest
      },
      async getPullRequestDiff(number, repository) {
        calls.push([repository, number])
        throw failure
      }
    },
    fixture.request
  )
  await assert.rejects(session.getPullRequestDiff(43), error => error === failure)
  await assert.rejects(session.getPullRequestDiff(42, "other/repo"), error => error === failure)
  failure.status = 403
  await assert.rejects(session.getPullRequestDiff(), error => error === failure)
  assert.deepEqual(calls, [
    ["owner/repo", 43],
    ["other/repo", 42],
    ["owner/repo", 42]
  ])
})

test("local retrieval rejects missing commits and a mismatched checkout head", async t => {
  const fixture = repository(t)
  for (const pullRequest of [
    { ...fixture.pullRequest, baseRefOid: "0".repeat(40) },
    { ...fixture.pullRequest, baseRefOid: null },
    { ...fixture.pullRequest, headRefOid: "0".repeat(40) }
  ]) {
    const session = new GitHubReviewSession(
      {
        async getPullRequest() {
          return pullRequest
        }
      },
      fixture.request
    )
    await assert.rejects(session.getPullRequestDiff())
  }
})

test("compacted large PRs fall back to a complete GitHub diff when local reconstruction is unavailable", async t => {
  const fixture = repository(t, 2)
  const unavailable = { ...fixture.pullRequest, baseRefOid: "0".repeat(40), additions: 2, deletions: 20_000 }
  let diffCalls = 0
  const session = new GitHubReviewSession(
    {
      async getPullRequest() {
        return unavailable
      },
      async getPullRequestDiff() {
        diffCalls += 1
        return fixture.raw
      }
    },
    fixture.request
  )
  const diff = await session.getPullRequestDiff()
  assert.equal(diffCalls, 1)
  assert.equal(diff.text, ReviewDiff.from(fixture.raw).text)
  assert.deepEqual(diff.files, ReviewDiff.from(fixture.raw).files)
})

test("compacted large PRs surface the local error when GitHub also cannot serve the diff", async t => {
  const fixture = repository(t, 2)
  const unavailable = { ...fixture.pullRequest, baseRefOid: null, additions: 2, deletions: 20_000 }
  const session = new GitHubReviewSession(
    {
      async getPullRequest() {
        return unavailable
      },
      async getPullRequestDiff() {
        throw Object.assign(new Error("diff too large"), { status: 406 })
      }
    },
    fixture.request
  )
  await assert.rejects(session.getPullRequestDiff(), /Cannot reconstruct the PR diff/u)
})

test("compaction keeps rename-with-modification pairing and anchors on the new path", async t => {
  const workspace = mkdtempSync(join(tmpdir(), "review-deleted-rename-"))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" })
  git("init", "-q")
  git("config", "user.email", "review@example.test")
  git("config", "user.name", "Review Test")
  git("config", "commit.gpgSign", "false")
  git("config", "core.hooksPath", "/dev/null")
  const commit = message => {
    git("add", "-A")
    git("-c", "user.name=Review Test", "-c", "user.email=review@example.test", "commit", "-qm", message)
  }
  writeFileSync(join(workspace, "retired.ts"), Array.from({ length: 10_002 }, (_, i) => `retired ${i}\n`).join(""))
  writeFileSync(
    join(workspace, "before.ts"),
    Array.from({ length: 100 }, (_, i) => `export const line${i} = ${i}\n`).join("")
  )
  commit("base")
  const base = git("rev-parse", "HEAD").trim()
  rmSync(join(workspace, "retired.ts"))
  renameSync(join(workspace, "before.ts"), join(workspace, "after.ts"))
  writeFileSync(
    join(workspace, "after.ts"),
    Array.from({ length: 100 }, (_, i) => `export const line${i} = ${i === 10 ? 999 : i}\n`).join("")
  )
  commit("head")
  const head = git("rev-parse", "HEAD").trim()
  const pullRequest = { number: 42, baseRefOid: base, headRefOid: head, additions: 1, deletions: 10_003 }
  const request = {
    repository: "owner/repo",
    prNumber: 42,
    workspace,
    workspaceHeadSha: head,
    botLogin: "review-bot",
    eventName: null,
    eventPath: null,
    actor: null,
    ignoreHistory: false
  }
  const session = new GitHubReviewSession(
    {
      async getPullRequest() {
        return pullRequest
      },
      async getPullRequestDiff() {
        throw new Error("GitHub diff must not be used when local compaction succeeds")
      }
    },
    request
  )
  const diff = await session.getPullRequestDiff()
  assert.doesNotMatch(diff.text, /retired \d/u)
  assert.match(diff.text, /rename from before\.ts/u)
  assert.match(diff.text, /rename to after\.ts/u)
  assert.match(diff.text, /\+export const line10 = 999/u)
  const renamed = diff.files.find(file => file.path === "after.ts")
  assert.equal(renamed.status, "modified")
  assert.deepEqual(renamed.addedLines, [[11, 11]])
  assert.equal(countDiffLines(diff.files.find(file => file.path === "retired.ts").deletedLines), 10_002)
})

test("a missing git executable settles both writers and falls back without leaking temporary diff files", t => {
  const fixture = repository(t, 2)
  const pullRequest = { ...fixture.pullRequest, deletions: 20_000 }
  const isolatedTmp = mkdtempSync(join(tmpdir(), "review-missing-git-"))
  t.after(() => rmSync(isolatedTmp, { recursive: true, force: true }))
  const script = [
    "import { readdirSync } from 'node:fs';",
    "import { GitHubReviewSession } from " +
      JSON.stringify(new URL("../dist/services/github/session.js", import.meta.url).href) +
      ";",
    "const { request, pullRequest, raw } = JSON.parse(process.argv[1]);",
    "const session = new GitHubReviewSession({ async getPullRequest() { return pullRequest; }, async getPullRequestDiff() { return raw; } }, request);",
    "const diff = await session.getPullRequestDiff();",
    "process.stdout.write(JSON.stringify({ text: diff.text, remaining: readdirSync(process.env.TMPDIR) }));"
  ].join("\n")
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        JSON.stringify({ request: fixture.request, pullRequest, raw: fixture.raw })
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, PATH: "", TMPDIR: isolatedTmp }
      }
    )
  )
  assert.equal(output.text, ReviewDiff.from(fixture.raw).text)
  assert.deepEqual(output.remaining, [])
})

test("filenames with spaces keep exact modified, renamed, and compacted deletion inventories", t => {
  const workspace = mkdtempSync(join(tmpdir(), "review-space-path-"))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
      cwd: workspace,
      encoding: "utf8"
    })
  git("init", "-q")
  for (const path of ["modified file.ts ", "old name.ts", "deleted file.ts"])
    writeFileSync(join(workspace, path), path + "\n")
  git("add", "--", "modified file.ts ", "old name.ts", "deleted file.ts")
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "base")
  writeFileSync(join(workspace, "modified file.ts "), "new\n")
  renameSync(join(workspace, "old name.ts"), join(workspace, "new name.ts"))
  rmSync(join(workspace, "deleted file.ts"))
  git("add", "--", "modified file.ts ", "old name.ts", "new name.ts", "deleted file.ts")
  const raw = git("diff", "--cached", "--find-renames")
  const model = git("diff", "--cached", "--find-renames", "-D")
  for (const diff of [ReviewDiff.from(raw), ReviewDiff.from(raw, model)]) {
    assert.deepEqual(
      diff.files.map(file => [file.path, file.status]),
      [
        ["deleted file.ts", "removed"],
        ["modified file.ts ", "modified"],
        ["new name.ts", "modified"]
      ]
    )
    assert.deepEqual(diff.commentRanges["modified file.ts "].added_lines, [[1, 1]])
    assert.deepEqual(diff.commentRanges["deleted file.ts"].deleted_lines, [[1, 1]])
    assert.deepEqual(diff.ignoredFiles, [])
  }
})

test("quoted rename paths decode tabs, quotes, backslashes, and UTF-8 octal bytes", () => {
  const diff = ReviewDiff.from(
    [
      'diff --git "a/old\\tname.ts" "b/new\\t\\303\\251\\\"\\\\name.ts"',
      "similarity index 100%",
      'rename from "old\\tname.ts"',
      'rename to "new\\t\\303\\251\\\"\\\\name.ts"',
      ""
    ].join("\n")
  )
  assert.deepEqual(
    diff.files.map(file => file.path),
    ['new\té"\\name.ts']
  )
  assert.deepEqual(Object.keys(diff.commentRanges), ['new\té"\\name.ts'])
})
