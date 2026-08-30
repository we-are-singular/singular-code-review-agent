import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { normalizeEvalInput } from "../eval/lib/pr-input.mjs"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test("eval inputs accept public history-blind pull requests", () => {
  assert.deepEqual(normalizeEvalInput({ pr: "trpc/trpc/7262", ignoreHistory: true }), {
    repository: "trpc/trpc",
    number: 7262,
    url: "https://github.com/trpc/trpc/pull/7262",
    ref: "trpc/trpc#7262",
    slug: "trpc-trpc-pr-7262",
    label: null,
    notes: null,
    ignoreHistory: true,
    baseSha: null,
    headSha: null
  })
})

test("eval inputs reject unsupported revision and history modes", () => {
  assert.throws(
    () => normalizeEvalInput({ pr: "trpc/trpc/7262", base: "1111111", head: "2222222" }),
    /fixed revisions are not supported/u
  )
  assert.throws(
    () => normalizeEvalInput({ pr: "trpc/trpc/7262", ignoreHistory: false }),
    /ignoreHistory=false is not supported/u
  )
})

test("committed eval inputs contain only the documented public examples", () => {
  const config = fs.readFileSync(path.join(repoRoot, "eval", "config.ts"), "utf8")
  const pullRequests = [...config.matchAll(/pr:\s*"([^"]+)"/gu)].map(match => match[1])

  assert.deepEqual(pullRequests, [
    "https://github.com/vercel/next.js/pull/31936",
    "https://github.com/TanStack/query/pull/7988",
    "https://github.com/trpc/trpc/pull/7262"
  ])
  assert.doesNotMatch(config, /private|example-org/iu)
  assert.equal(fs.readFileSync(path.join(repoRoot, "eval", "runs", ".gitignore"), "utf8"), "*\n!.gitignore\n")
  assert.equal(fs.readFileSync(path.join(repoRoot, "eval", "cache", ".gitignore"), "utf8"), "*\n!.gitignore\n")
})
