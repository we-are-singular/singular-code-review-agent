import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { main, reviewExitCode } from "../dist/cli/review.js"
import { OpenCodeModelCatalog } from "../dist/lib/opencode-models.js"
import { ReviewUnavailableError, runReview } from "../dist/run-review.js"

const catalogText = JSON.stringify({
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    env: ["OPENCODE_API_KEY"],
    models: {
      "deepseek-v4.1-flash": { id: "deepseek-v4.1-flash" },
      "deepseek-v4-flash": { id: "deepseek-v4-flash", status: "deprecated" },
      "glm-6-preview": { id: "glm-6-preview", status: "alpha" }
    }
  },
  openai: { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], models: { "gpt-5": { id: "gpt-5" } } }
})

/** Serves the catalog endpoint locally and records every requested path. */
async function catalogServer(t, respond = (_request, response) => response.end(catalogText)) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    respond(request, response)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  return { url: `http://127.0.0.1:${server.address().port}`, requests }
}

async function pinned(t, env) {
  const catalog = await OpenCodeModelCatalog.pin(env)
  assert.ok(catalog)
  t.after(() => catalog.close())
  return catalog
}

/** Points os.tmpdir() at an empty directory so the test can see what the runner leaves behind. */
function isolatedTemp(t) {
  const directory = mkdtempSync(join(tmpdir(), "review-models-temp-"))
  const previous = process.env.TMPDIR
  process.env.TMPDIR = directory
  t.after(() => {
    // Assigning undefined would store the string "undefined" where TMPDIR was unset (e.g. Linux CI).
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

test("the review pins OPENCODE_MODELS_URL's catalog verbatim in a file it removes", async t => {
  const server = await catalogServer(t)
  const catalog = await OpenCodeModelCatalog.pin({ OPENCODE_MODELS_URL: server.url })

  assert.deepEqual(server.requests, ["/api.json"])
  assert.equal(readFileSync(catalog.path, "utf8"), catalogText)
  catalog.close()
  assert.equal(existsSync(catalog.path), false)
})

test("OpenCode-provided models are judged by the status OpenCode filters on", async t => {
  const server = await catalogServer(t)
  const catalog = await pinned(t, { OPENCODE_MODELS_URL: server.url })

  assert.equal(catalog.unavailableReason("opencode-go/deepseek-v4.1-flash"), null)
  assert.match(
    catalog.unavailableReason("opencode-go/deepseek-v4-flash"),
    /"opencode-go\/deepseek-v4-flash" is deprecated/u
  )
  assert.match(
    catalog.unavailableReason("opencode-go/deepseek-flash"),
    /is not in the OpenCode model catalog from http/u
  )
  // A provider absent from the catalog has nothing OpenCode could advertise either.
  assert.match(catalog.unavailableReason("opencode/deepseek-v4.1-flash"), /is not in the OpenCode model catalog/u)
  assert.match(
    catalog.unavailableReason("opencode-go/glm-6-preview"),
    /alpha model; set OPENCODE_ENABLE_EXPERIMENTAL_MODELS/u
  )

  const experimental = await pinned(t, { OPENCODE_MODELS_URL: server.url, OPENCODE_ENABLE_EXPERIMENTAL_MODELS: "true" })
  assert.equal(experimental.unavailableReason("opencode-go/glm-6-preview"), null)
  // OpenCode's case-sensitive config parser rejects "TRUE", so it must not enable alpha models here either.
  const uppercase = await pinned(t, { OPENCODE_MODELS_URL: server.url, OPENCODE_ENABLE_EXPERIMENTAL_MODELS: "TRUE" })
  assert.match(uppercase.unavailableReason("opencode-go/glm-6-preview"), /alpha model/u)
})

test("providers whose model lists plugins replace are left for OpenCode to judge", async t => {
  const server = await catalogServer(t)
  const catalog = await pinned(t, { OPENCODE_MODELS_URL: server.url })

  assert.equal(catalog.unavailableReason("openai/gpt-5.5-codex"), null)
  assert.equal(catalog.unavailableReason("github-copilot/claude-sonnet-5-5"), null)
})

test("operator-fixed catalogs are respected without a fetch", async t => {
  const server = await catalogServer(t)

  assert.equal(
    await OpenCodeModelCatalog.pin({ OPENCODE_MODELS_URL: server.url, OPENCODE_MODELS_PATH: "/x.json" }),
    null
  )
  assert.equal(
    await OpenCodeModelCatalog.pin({ OPENCODE_MODELS_URL: server.url, OPENCODE_DISABLE_MODELS_FETCH: "TRUE" }),
    null
  )
  assert.deepEqual(server.requests, [])
})

test("unusable catalog responses fail with the source and their root cause", async t => {
  const responses = {
    "/unavailable": response => {
      response.statusCode = 503
      response.end("busy")
    },
    "/html": response => response.end("<!doctype html>"),
    "/empty": response => response.end("{}"),
    "/hang": () => {}
  }
  const server = await catalogServer(t, (request, response) =>
    responses[request.url.replace("/api.json", "")](response)
  )
  const temp = isolatedTemp(t)
  const failure = async (path, cause) =>
    assert.rejects(
      OpenCodeModelCatalog.pin({ OPENCODE_MODELS_URL: `${server.url}${path}` }, { timeoutMs: 200 }),
      error => {
        assert.equal(error.message, `cannot load ${server.url}${path}/api.json`)
        assert.match(error.cause.message, cause)
        return true
      }
    )

  await failure("/unavailable", /^HTTP 503$/u)
  await failure("/html", /not valid JSON/u)
  await failure("/empty", /^response is not a model catalog$/u)
  await failure("/hang", /timeout/u)
  assert.deepEqual(readdirSync(temp), [])
})

test("the runner hands the pinned catalog path to the OpenCode provider", async () => {
  let providerOptions
  await assert.rejects(
    runReview(
      {
        request: {
          repository: "owner/repository",
          prNumber: 42,
          workspace: tmpdir(),
          workspaceHeadSha: "2".repeat(40),
          botLogin: "singular-code-review[bot]",
          eventName: null,
          eventPath: null,
          actor: "author",
          ignoreHistory: false
        },
        github: {},
        actionMode: "dry-run",
        model: "opencode-go/deepseek-v4.1-flash",
        modelsPath: "/pinned/models.json",
        maximumConcurrency: 1
      },
      options => {
        providerOptions = options
        throw new Error("stop before any Agent starts")
      }
    ),
    ReviewUnavailableError
  )
  assert.equal(providerOptions.modelsPath, "/pinned/models.json")
})

function cliArguments(workspace, model) {
  return ["--repo", "owner/repository", "--pr", "42", "--workspace", workspace, "--model", model]
}

test("a model the pinned catalog cannot serve exits for the fallback model before review work", async t => {
  const server = await catalogServer(t)
  const temp = isolatedTemp(t)

  // The workspace is not a Git checkout, so reaching the review itself would fail differently.
  const failure = await main(cliArguments(temp, "opencode-go/deepseek-v4-flash"), {
    GH_TOKEN: "test-token",
    OPENCODE_MODELS_URL: server.url
  }).then(
    () => assert.fail("the deprecated model must not start a review"),
    error => error
  )
  assert.ok(failure instanceof ReviewUnavailableError)
  assert.match(failure.message, /^review unsuccessful: model "opencode-go\/deepseek-v4-flash" is deprecated/u)
  assert.equal(reviewExitCode(failure), 2)
  assert.deepEqual(readdirSync(temp), [])
})

test("a failed catalog fetch is logged and the review continues with OpenCode's own loading", async t => {
  const server = await catalogServer(t, (_request, response) => {
    response.statusCode = 503
    response.end()
  })
  const temp = isolatedTemp(t)
  const stderr = []
  t.mock.method(process.stderr, "write", line => stderr.push(String(line)))

  await assert.rejects(
    main(cliArguments(temp, "opencode-go/deepseek-v4-flash"), {
      GH_TOKEN: "test-token",
      OPENCODE_MODELS_URL: server.url
    }),
    /cannot read the checked-out commit/u
  )
  assert.deepEqual(stderr, [
    `review_runner: OpenCode model catalog not pinned: cannot load ${server.url}/api.json: HTTP 503\n`
  ])
})
