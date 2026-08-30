import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("Dockerfile packages only the canonical AML-backed reviewer surface", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8")
  const evalRunner = fs.readFileSync(path.join(repoRoot, "eval", "run.mjs"), "utf8")
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"))

  assert.match(
    dockerfile,
    /^ARG BASE_IMAGE=docker\.io\/wearesingular\/aml-agent-sandbox:0\.3\.3@sha256:cc4ab80e39c861ec2f59e0f2fd319de0c3801a7d863dab21ae7857e96a6794d2$/m
  )
  assert.match(dockerfile, /^FROM \$\{BASE_IMAGE\} AS review-build$/m)
  assert.match(
    evalRunner,
    /docker\.io\/wearesingular\/aml-agent-sandbox:0\.3\.3@sha256:cc4ab80e39c861ec2f59e0f2fd319de0c3801a7d863dab21ae7857e96a6794d2/u
  )
  assert.match(dockerfile, /^ARG CONTEXT7_MCP_VERSION=3\.2\.4$/m)
  assert.match(dockerfile, /COPY package\.json package-lock\.json tsconfig\.json \.[/]/)
  assert.match(dockerfile, /COPY src\/ \.\/src\//)
  assert.doesNotMatch(dockerfile, /COPY aml\/|COPY opencode\/|tsconfig\.aml/u)
  assert.doesNotMatch(dockerfile, /\bbuild-essential\b/u)
  assert.match(dockerfile, /HUSKY=0 npm ci --include=dev/)
  assert.match(dockerfile, /npm run build/)
  assert.match(dockerfile, /npm prune --omit=dev/)
  assert.match(dockerfile, /npm install -g @upstash\/context7-mcp@\$\{CONTEXT7_MCP_VERSION\}/)
  assert.match(dockerfile, /^ARG SKILLS_CLI_VERSION=1\.5\.23$/m)
  assert.match(dockerfile, /--skill backend-architecture frontend-architecture/)
  assert.doesNotMatch(dockerfile, /apt-get|\bgh\b/u)
  assert.match(
    dockerfile,
    /ln -sf \/usr\/local\/lib\/singular-code-review\/dist\/cli\/review\.js \/usr\/local\/bin\/review_runner/
  )
  assert.match(
    dockerfile,
    /ln -sf \/usr\/local\/lib\/singular-code-review\/dist\/cli\/preflight\.js \/usr\/local\/bin\/review_preflight/
  )
  assert.doesNotMatch(
    dockerfile,
    /review_dry_run|aml_review|review_ack|review_comments|review_context|review_extract|review_guard/u
  )
  assert.match(dockerfile, /USER aml\s*\nCMD/)
  assert.equal(packageJson.dependencies["@aml-jsx/sdk"], "0.7.1")
  assert.deepEqual(Object.keys(packageJson.bin).sort(), ["review_preflight", "review_runner"])
})

test("example trigger workflow reviews new heads and trusted mentions", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, "examples", "singular-code-review.yml"), "utf8")

  assert.match(workflow, /pull_request:\s*\n\s*types: \[opened, ready_for_review, synchronize\]/)
  assert.match(workflow, /issue_comment:\s*\n\s*types: \[created\]/)
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/)
  assert.match(workflow, /contains\(github\.event\.comment\.body, '@singular-code-review'\)/)
  assert.match(workflow, /github\.event\.comment\.user\.type != 'Bot'/)
  assert.match(workflow, /github\.event\.comment\.user\.login == github\.event\.issue\.user\.login/)
  assert.match(
    workflow,
    /concurrency:\s*\n\s+group: singular-code-review-\$\{\{ github\.event\.issue\.number \|\| github\.event\.pull_request\.number \|\| github\.event\.inputs\.pr_number \}\}/
  )
})

test("publish workflow validates and builds the same reviewer image", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "publish-image.yml"), "utf8")

  assert.match(workflow, /uses: actions\/checkout@v7/)
  assert.match(workflow, /uses: actions\/setup-node@v7/)
  assert.match(workflow, /node-version: 26/)
  assert.match(workflow, /uses: docker\/setup-buildx-action@v4/)
  assert.match(workflow, /uses: docker\/login-action@v4/)
  assert.match(workflow, /uses: docker\/metadata-action@v6/)
  assert.match(workflow, /uses: docker\/build-push-action@v7/)
  assert.doesNotMatch(workflow, /use-local-aml-sdk|build-local-aml-base|AML_SANDBOX_REVISION/u)
})

test("reusable workflow preflights once and publishes through the production review tree", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "review.yml"), "utf8")

  assert.match(workflow, /uses: actions\/create-github-app-token@v3/)
  assert.match(workflow, /uses: actions\/checkout@v7/)
  assert.match(workflow, /if \/usr\/local\/bin\/review_preflight; then/)
  assert.match(workflow, /else\s+status=\$\?/)
  assert.match(workflow, /review_preflight attempt \$\{attempt\}\/2/)
  assert.match(
    workflow,
    /REVIEW_MODEL: \$\{\{ vars\.REVIEW_MODEL \|\| vars\.OPENCODE_MODEL \|\| 'opencode-go\/deepseek-v4-flash' \}\}/
  )
  assert.match(workflow, /ref: refs\/pull\/\$\{\{ inputs\.pr_number \}\}\/head/)
  assert.doesNotMatch(workflow, /gh pr checkout/u)
  assert.match(workflow, /SINGULAR_CODE_REVIEW_INSTALL_DEPS: \$\{\{ inputs\.npm_install \}\}/)
  assert.match(
    workflow,
    /name: Run Singular Code Review\s+if: steps\.review-preflight\.outputs\.should_review == 'true'\s+timeout-minutes: 42\s+run: timeout 40m \/usr\/local\/bin\/review_runner --publish/
  )
  assert.ok(workflow.indexOf("Run review preflight") < workflow.indexOf("Create GitHub App token"))
  assert.match(workflow, /REVIEW_BOT_LOGIN: \$\{\{ steps\.app-token\.outputs\.app-slug \}\}\[bot\]/)
  assert.doesNotMatch(workflow, /^\s+BOT_LOGIN:/mu)
  assert.doesNotMatch(workflow, /review_ack|review_extract|OPENCODE_MODEL_FALLBACK|OPENCODE_GATE_MODEL/u)
})
