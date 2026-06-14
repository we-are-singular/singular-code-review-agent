# Singular Code Review Agent

Singular Code Review Agent packages an automated pull-request reviewer as a
container image for GitHub Actions. It runs OpenCode against a pull request,
collects review findings through local helper tools, validates every inline
comment against the changed lines in the current diff, and submits one batched
GitHub review from a GitHub App identity.

The project is designed to be operated centrally: this repository builds and
publishes the reviewer image and exposes a reusable workflow, while consuming
repositories opt in with a small trigger workflow and runtime secrets.


## Distribution model

This is open-source infrastructure for Singular's own repositories, not a
hosted public review service. The workflow in this repository is wired to the
Singular-owned GitHub App identity and expects the consuming repository to
provide that App's private key as an Actions secret.

That means:

- Singular repositories can use this directly after the App is installed and
  the required org or repo secrets are available.
- Outside repositories cannot use the Singular App unless they have the
  private key, which they should not have.
- Forks are welcome to run their own copy by creating their own GitHub App and
  updating the hardcoded App identity in the forked source, including the App
  client ID, bot login, and command trigger if they want different names.

The current design intentionally runs inside the consuming repository's GitHub
Actions environment. It is easy to operate for trusted repositories, but it is
not an install-only SaaS model: the consuming repository still needs a small
workflow file and the runtime secrets required by that workflow.

## What it provides

- A reproducible Docker image built from an OpenCode sandbox base image.
- A reusable GitHub Actions workflow that checks out a pull request, provisions
  the reviewer runtime, and runs the TypeScript review runner.
- A TypeScript runner that gathers pull-request context, executes OpenCode,
  validates staged findings, builds the final review payload, and submits it
  through a GitHub App token.
- Local review tools that let the agent stage inline comments, multiline
  comments, suggestions, replies, and the synthesized overall conclusion before
  submission.
- Static OpenCode reviewer/auditor agent instruction files, centralized review prompts,
  and vendored reviewer skills that keep the agent focused on actionable code
  review feedback.
- No-network test coverage for the review contracts, OpenCode client, guard/ack
  decisions, runner pipeline, workflow, and image packaging.

## How it works

At runtime, the reusable workflow mints a GitHub App installation token and uses
that token for checkout, context reads, review replies, and review submission.
The container then runs `provision.sh` followed by `review_runner`.
Provisioning installs the committed OpenCode config and target-repository
dependencies. The runner then:

1. fetches normalized pull-request context with `review_context`;
2. starts OpenCode with the bundled `reviewer` agent and review phase prompt;
3. lets the agent queue findings and replies through `review_comments`;
4. validates queued comments against the current diff;
5. runs the OpenCode `auditor` agent in an audit phase that edits the queue file to remove
   duplicates, merge overlapping comments, and keep distinct same-line findings;
6. validates the audited queue so only valid RIGHT-side additions and LEFT-side deletions are
   submitted;
7. runs the OpenCode `auditor` agent in a synthesis phase to create the final review body from the
   reviewer output and validated queue;
8. posts a single GitHub review whose body uses the synthesized conclusion and
   any queued inline comments, plus any queued replies.

OpenCode invocations are routed through `src/clients/opencode.ts`, which keeps
rendered output and raw JSON event streams as runtime artifacts when supported
and reuses the same auditor OpenCode session for queue audit and final
synthesis.

The image keeps credentials out of the build. Runtime secrets are provided by
the consuming repository, while reviewer settings such as the command trigger,
GitHub App client ID, image, and OpenCode agents are owned by this repository.
Consuming repositories can optionally set the `OPENCODE_MODEL` repository
variable to try a different model without changing workflow YAML.

## Install on a repository

1. Install the Singular Code Review GitHub App on the target repository or on
   the owning organization with access to that repository.
2. Add these Actions secrets to the repository, or preferably as organization
   secrets scoped to selected repositories:
   - `SINGULAR_CODE_REVIEW_PRIVATE_KEY`: private key for the GitHub App.
   - `OPENCODE_API_KEY`: OpenCode Go API key used by the reviewer.
   - `CONTEXT7_API_KEY`: optional Context7 API key.
3. Optionally set the repository variable `OPENCODE_MODEL` to use a different
   model. If omitted, the reusable workflow defaults to
   `opencode-go/minimax-m2.7`.
4. Copy `examples/singular-code-review.yml` into the target repository as
   `.github/workflows/singular-code-review.yml`.
5. Open a non-draft same-repository pull request, mark a same-repository draft
   pull request ready for review, or have a human `OWNER`, `MEMBER`, or
   `COLLABORATOR` comment `@singular-code-review` on a same-repository pull
   request.

For one repository, secrets can be added directly:

```bash
gh secret set --repo OWNER/REPO SINGULAR_CODE_REVIEW_PRIVATE_KEY < app-private-key.pem
gh secret set --repo OWNER/REPO OPENCODE_API_KEY --body "$OPENCODE_API_KEY"
gh secret set --repo OWNER/REPO CONTEXT7_API_KEY --body "$CONTEXT7_API_KEY" # optional
```

For multiple trusted repositories, prefer organization secrets scoped to the
selected repositories instead of copying values manually into each repository.

The target repository does not receive a long-lived GitHub token. During each
workflow run, `actions/create-github-app-token` uses the private key to mint a
short-lived installation token for the App installation on that repository.
That token is used for checkout, GitHub context reads, review comment replies,
and the final batched review submission.

## Security model

The reviewer checks out pull-request code and may run dependency installation,
so it must treat fork pull requests as untrusted code. The example trigger
workflow avoids calling the reusable workflow for fork `pull_request` events,
and the reusable workflow has its own preflight guard that blocks fork pull
requests before creating the GitHub App token, checking out code, installing
dependencies, or starting OpenCode.

Mention-triggered reviews are restricted to human `OWNER`, `MEMBER`, or
`COLLABORATOR` comments and are still denied when the pull request head is a
fork. The caller job also cancels older in-progress review runs for the same
pull request, and the reusable workflow has the same PR-scoped concurrency
guard for older copied client workflows. Repeated commands should not run paid
reviews in parallel.

This still assumes the consuming repository's branches and write collaborators
are trusted enough to run code with the repository's Actions secrets. For public
repositories that accept arbitrary fork PRs, keep this workflow on the normal
`pull_request`/`issue_comment` model and do not convert it to
`pull_request_target`.

## Repository map

- `Dockerfile` defines the reviewer image.
- `bin/provision.sh` prepares OpenCode config, trusts the checkout directory,
  and installs target-repository dependencies.
- `review_runner` runs the TypeScript review pipeline.
- `review_context` collects pull-request metadata, mentions, previous bot
  comments, review thread state when available, valid diff lines, and action
  items.
- `review_auditor_context.json` is a compact runtime artifact derived from the
  full context for audit and synthesis prompts.
- `review_comments` is the staging interface used by OpenCode and the
  runner for comments, suggestions, multiline findings, replies, listing, and
  status checks.
- `review_guard` and `review_ack` are typed GitHub Actions preflight
  helpers for trigger authorization and idempotent request acknowledgment.
- `bin/review_dry_run` checks out a real GitHub pull request into a disposable
  workspace and runs the normal runner with GitHub writes blocked.
- `src/review/workflow.ts` owns the named gathering, review, audit, and
  synthesis phases.
- `src/review/` contains queue, diff, context, body, and shared review
  contracts.
- `src/prompts/` contains versioned Markdown prompt assets plus the prompt
  loader/interpolator.
- `src/lib/` contains shared runtime helpers for artifacts, logging, JSON,
  CLI entrypoints, and errors.
- `opencode/opencode.json` configures OpenCode and reads secrets through
  environment placeholders.
- `opencode/agents/reviewer.md` contains durable reviewer-agent instructions.
- `opencode/agents/auditor.md` contains durable audit/synthesis-agent
  instructions.
- `opencode/skills/` contains vendored reviewer skills used inside the image.
- `.github/workflows/publish-image.yml` builds and publishes the image to GHCR.
- `.github/workflows/review.yml` is the reusable workflow consumed by target
  repositories.
- `examples/singular-code-review.yml` is an example trigger workflow for a
  consuming repository.
- `test/` contains Node test suites for the stable production contracts.

## Published image

Pushes to `main` publish the reviewer image to GitHub Container Registry as:

```text
ghcr.io/we-are-singular/singular-code-review-agent:latest
ghcr.io/we-are-singular/singular-code-review-agent:sha-<commit>
```

Pull requests build the image without publishing it. The source repository can
be public while the GitHub App private key remains private in the trusted
consuming repositories that run the workflow.

## Runtime Inputs

The reusable workflow exposes only the pull request/comment identifiers as
inputs. It owns the GitHub App client ID, command trigger, container image,
OpenCode model, and OpenCode agents.

The runner receives these required runtime environment variables from the
reusable workflow:

- `GH_TOKEN`: token used by Octokit for GitHub context reads and writes.
- `GITHUB_REPOSITORY`: repository in `owner/name` form.
- `PR_NUMBER`: pull request number to review.
- `OPENCODE_API_KEY`: OpenCode Go API key consumed by the bundled provider
  configuration.

Optional runtime environment variables:

- `OPENCODE_MODEL`: model id used by the bundled `reviewer` and `auditor`
  agents; defaults to `opencode-go/minimax-m2.7`.
- `CONTEXT7_API_KEY`: optional Context7 key for higher rate limits.
- `DRY_RUN=true`: local development override that prints the final review
  payload instead of submitting it.

Dependency installation is automatic during `bin/provision.sh` when the
checked-out pull-request workspace contains `package.json`. Provisioning chooses
`pnpm`, `yarn`, or `npm` based on the lockfile present in the workspace. For
npm workspaces, provisioning passes `--dangerously-allow-all-scripts` so
required install-time builds such as native modules and generated clients run
inside the reviewer sandbox.

## Reviewer behavior

The bundled `opencode/agents/reviewer.md` and `opencode/agents/auditor.md`
files are copied into the image as static OpenCode agent instructions. Target
repositories can still provide their own `AGENTS.md` files for project-specific
context, but the bundled agent instructions remain authoritative for the
reviewer and auditor workflow.

In this repository, OpenCode agent files are the durable role instructions,
while files under `src/prompts/` are phase prompts passed to a specific
`opencode run` invocation.

Review text should be passed with stdin or files rather than shell-quoted inline
arguments, for example:

```bash
review_comments add --path "src/app.js" --line "42" --body-stdin <<'REVIEW_COMMENT'
This preserves Markdown like `code`, "$values", and code snippets without shell escaping.
REVIEW_COMMENT
```

When GitHub review thread data is available, validation drops new inline
comments that exactly match unresolved bot thread comments. If thread state is
unavailable, validation still uses the REST review-comment list to drop exact
repeated bot comments. Broader semantic cleanup, such as merging overlapping
same-line comments while preserving genuinely distinct issues, is handled by the
queue audit pass before final validation.

## Vendored skills

The image vendors these skills from `we-are-singular/skills` at commit
`fc5dbad9c36df9f133a1c2221ef8d1212f0c36b1`:

- `backend-architecture`
- `frontend-architecture`
- `singular-code-review`

Vendoring keeps image builds reproducible and avoids pulling skill content with 
`npx` or GitHub during the Docker build. Update the snapshot by replacing the skill 
directories under `opencode/skills/` and updating `opencode/skills/VENDORED_SKILLS.md`.

## Local development

The local test suite builds the TypeScript runner and uses Node's built-in test
runner with mocked external clients:

```bash
npm test
```

For local image validation, build the container with:

```bash
docker build -t singular-code-review:local .
```

The base image defaults to the known working OpenCode sandbox image and can be
overridden with the `BASE_IMAGE` build argument when validating a newer sandbox
release.

To inspect the review that would be posted for a real pull request without
posting anything to GitHub, run:

```bash
OPENCODE_API_KEY=... bin/review_dry_run owner/repo 123
```

The command clones the target repository into `/tmp/singular-code-review-dry-run`,
checks out the PR head, sets `DRY_RUN=true`, and puts a read-only `gh` wrapper in
front of OpenCode investigation. The runner prints the final review payload to
stdout and keeps artifacts under `/tmp/.singular-code-review/`, including
`review_payload.json`, `review_validated.json`,
`review_context.json`, `review_auditor_context.json`, `pr.diff`, and the
OpenCode output logs.

Use `--runtime-dir <path>` or `SINGULAR_CODE_REVIEW_RUNTIME_DIR=<path>` when
running dry-runs inside a disposable container so artifacts are written to a
mounted or otherwise persistent directory.
