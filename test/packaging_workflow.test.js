import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("Dockerfile builds and packages the TypeScript runner surface", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8")

  assert.match(dockerfile, /^ARG NODE_VERSION=26\.3\.0$/m)
  assert.match(dockerfile, /^ARG NPM_MIN_VERSION=11\.13\.0$/m)
  assert.match(dockerfile, /\bbuild-essential\b/)
  assert.match(dockerfile, /\bpython3\b/)
  assert.match(dockerfile, /\bripgrep\b/)
  assert.match(dockerfile, /\bsqlite3\b/)
  assert.match(dockerfile, /npm ci/)
  assert.match(dockerfile, /npm run build/)
  assert.match(dockerfile, /\/usr\/local\/lib\/singular-code-review/)
  assert.match(dockerfile, /review_runner/)
  assert.match(dockerfile, /review_extract/)
  assert.match(
    dockerfile,
    /ln -sf \/usr\/local\/lib\/singular-code-review\/dist\/cli\/review-runner\.js \/usr\/local\/bin\/review_runner/
  )
  assert.match(
    dockerfile,
    /ln -sf \/usr\/local\/lib\/singular-code-review\/dist\/cli\/review-extract\.js \/usr\/local\/bin\/review_extract/
  )
  assert.match(dockerfile, /COPY opencode\/agents\/ \/usr\/local\/share\/singular-code-review\/agents\//)
  assert.match(dockerfile, /COPY opencode\/skills\/ \/usr\/local\/share\/singular-code-review\/skills\//)
  assert.match(dockerfile, /provision\.sh/)
  assert.doesNotMatch(dockerfile, /COPY opencode\/AGENTS\.md/)
  assert.doesNotMatch(dockerfile, /COPY bin\/review_runner/)
  assert.doesNotMatch(dockerfile, /review_orchestrator/)
  assert.doesNotMatch(dockerfile, /opencode_step/)
  assert.doesNotMatch(dockerfile, /lib\/review-tools/)
})

test("OpenCode config defines reviewer and auditor agents with scoped permissions", () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, "opencode", "opencode.json"), "utf8"))

  assert.deepEqual(config.permission.edit, {
    "*": "deny",
    "/tmp/.singular-code-review/**": "allow"
  })
  assert.deepEqual(config.permission.read, {
    "*": "allow",
    "*.env": "allow",
    "*.env.test": "allow"
  })
  assert.deepEqual(config.permission.external_directory, {
    "/tmp/.singular-code-review/**": "allow"
  })
  assert.equal(config.default_agent, "reviewer")
  assert.equal(config.agent.reviewer.prompt, "{file:./agents/reviewer.md}")
  assert.equal(config.agent.gate.model, "{env:OPENCODE_GATE_MODEL}")
  assert.equal(config.agent.gate.prompt, "{file:./agents/gate.md}")
  assert.equal(config.agent.auditor.prompt, "{file:./agents/auditor.md}")
  assert.equal(Object.hasOwn(config.agent.reviewer, "permission"), false)
  assert.deepEqual(config.agent.gate.permission, {
    edit: "deny",
    bash: "deny",
    webfetch: "deny"
  })
  assert.deepEqual(config.agent.auditor.permission, {
    bash: "deny",
    webfetch: "deny"
  })
  assert.equal(fs.existsSync(path.join(repoRoot, "opencode", "agents", "reviewer.md")), true)
  assert.equal(fs.existsSync(path.join(repoRoot, "opencode", "agents", "gate.md")), true)
  assert.equal(fs.existsSync(path.join(repoRoot, "opencode", "agents", "auditor.md")), true)

  const auditorAgent = fs.readFileSync(path.join(repoRoot, "opencode", "agents", "auditor.md"), "utf8")
  assert.match(auditorAgent, /Sandbox diagnostics:/)
  assert.match(auditorAgent, /denials usually mean the sandbox worked/u)
})

test("example trigger workflow runs gate-capable reviews on new pull request heads", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, "examples", "singular-code-review.yml"), "utf8")

  assert.match(workflow, /pull_request:\s*\n\s*types: \[opened, ready_for_review, synchronize\]/)
  assert.doesNotMatch(workflow, /\breopened\b/)
  assert.match(workflow, /issue_comment:\s*\n\s*types: \[created\]/)
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/)
  assert.match(workflow, /contains\(github\.event\.comment\.body, '@singular-code-review'\)/)
  assert.match(workflow, /github\.event\.comment\.user\.type != 'Bot'/)
  assert.match(
    workflow,
    /concurrency:\s*\n\s+group: singular-code-review-\$\{\{ github\.event\.issue\.number \|\| github\.event\.pull_request\.number \|\| github\.event\.inputs\.pr_number \}\}/
  )
  assert.doesNotMatch(workflow, /"CONTRIBUTOR"/)
})

test("publish workflow uses Node 26 and Node 24-backed action runtimes", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "publish-image.yml"), "utf8")

  assert.match(workflow, /uses: actions\/checkout@v7/)
  assert.match(workflow, /uses: actions\/setup-node@v6/)
  assert.match(workflow, /node-version: 26/)
  assert.match(workflow, /uses: docker\/setup-buildx-action@v4/)
  assert.match(workflow, /uses: docker\/login-action@v4/)
  assert.match(workflow, /uses: docker\/metadata-action@v6/)
  assert.match(workflow, /uses: docker\/build-push-action@v7/)
  assert.doesNotMatch(workflow, /uses: actions\/(?:checkout|setup-node)@v4/)
  assert.doesNotMatch(workflow, /uses: docker\/(?:setup-buildx-action|login-action)@v3/)
  assert.doesNotMatch(workflow, /uses: docker\/metadata-action@v5/)
  assert.doesNotMatch(workflow, /uses: docker\/build-push-action@v6/)
})

test("reusable workflow runs guard, ack, provisioning, and the new runner", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "review.yml"), "utf8")

  assert.match(workflow, /uses: actions\/create-github-app-token@v3/)
  assert.match(workflow, /uses: actions\/checkout@v7/)
  assert.doesNotMatch(workflow, /uses: actions\/checkout@v4/)
  assert.match(workflow, /run: \/usr\/local\/bin\/review_guard/)
  assert.match(workflow, /npm_install:\s*\n\s+description: Install repository dependencies before review\./)
  assert.match(workflow, /type: boolean\s*\n\s+default: false/)
  assert.match(workflow, /run: \/usr\/local\/bin\/review_ack/)
  assert.match(workflow, /name: Provision review workspace/)
  assert.match(workflow, /\/usr\/local\/bin\/provision\.sh/)
  assert.match(
    workflow,
    /OPENCODE_GATE_MODEL: \$\{\{ vars\.OPENCODE_GATE_MODEL \|\| 'opencode-go\/deepseek-v4-flash' \}\}/
  )
  assert.match(workflow, /SINGULAR_CODE_REVIEW_INSTALL_DEPS: \$\{\{ inputs\.npm_install \}\}/)
  assert.match(
    workflow,
    /name: Run Singular Code Review\s+if: steps\.review-request\.outputs\.should_review == 'true'\s+timeout-minutes: 42\s+run: \|\s+for attempt in 1 2; do/
  )
  assert.ok(workflow.indexOf("Run review guard") < workflow.indexOf("Create GitHub App token"))
  assert.ok(workflow.indexOf("Run review guard") < workflow.indexOf("Provision review workspace"))
  assert.match(workflow, /timeout 20m \/usr\/local\/bin\/review_runner/)
  assert.match(workflow, /review_runner attempt \$\{attempt\}\/2/)
  assert.match(workflow, /\/usr\/local\/bin\/review_runner/)
  assert.match(workflow, /BOT_LOGIN: \$\{\{ steps\.app-token\.outputs\.app-slug \}\}\[bot\]/)
  assert.match(workflow, /Extract review outputs and telemetry/)
  assert.match(workflow, /\/usr\/local\/bin\/review_extract --github-summary/)
  assert.doesNotMatch(workflow, /review_guard\.sh/)
  assert.doesNotMatch(workflow, /review_ack\.sh/)
  assert.doesNotMatch(workflow, /review_orchestrator/)
  assert.doesNotMatch(workflow, /concurrency:/)
  assert.doesNotMatch(workflow, /singular-code-review-\$\{\{ inputs\.pr_number \}\}/)
})
