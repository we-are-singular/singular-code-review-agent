# Singular Code Review Agent

Singular Code Review Agent packages an automated pull-request reviewer as a
container image for GitHub Actions. It runs OpenCode against a pull request,
collects review findings through local helper tools, validates every inline
comment against the changed lines in the current diff, and submits one batched
GitHub review from a GitHub App identity.

The project is designed to be operated centrally: this repository builds and
publishes the reviewer image and exposes a reusable workflow, while consuming
repositories opt in with a small trigger workflow and runtime secrets.
The example trigger workflow runs on non-draft PR creation, when a draft PR is
marked ready for review, or when someone posts a PR comment containing
`@singular-code-review`; it does not run on every push to an existing PR.

## What it provides

- A reproducible Docker image built from an OpenCode sandbox base image.
- A reusable GitHub Actions workflow that checks out a pull request, prepares
  the reviewer runtime, and runs the review orchestrator.
- A review orchestration script that gathers pull-request context, executes
  OpenCode, filters staged findings to valid diff positions, and submits the
  final review payload.
- Local review tools that let the agent stage inline comments, multiline
  comments, suggestions, replies, and the synthesized overall conclusion before
  submission.
- A review-only OpenCode prompt and vendored reviewer skills that keep the
  agent focused on actionable code review feedback.
- No-network test coverage for the review tools and orchestrator behavior using
  mocked command-line dependencies.

## How it works

At runtime, the reusable workflow mints a GitHub App installation token and uses
that token for checkout, `gh` operations, and review submission. The container
then runs `bin/review_orchestrator.sh`, which:

1. fetches normalized pull-request context with `bin/review_context`;
2. starts OpenCode with the bundled configuration and review-only prompt;
3. lets the agent queue findings and replies through `bin/review_comments`;
4. filters queued comments so only valid RIGHT-side changed lines are submitted;
5. runs a second OpenCode pass to synthesize the final review body from the
   reviewer output;
6. posts a single GitHub review whose body uses the synthesized conclusion and
   any queued inline comments, plus any queued replies.

The image keeps credentials out of the build. Runtime secrets are provided by
the consuming repository, while reviewer settings such as the command trigger,
GitHub App client ID, image, and OpenCode agent are owned by this repository.
Consuming repositories can optionally set the `OPENCODE_MODEL` repository
variable to try a different model without changing workflow YAML.

## Repository map

- `Dockerfile` defines the reviewer image.
- `bin/review_orchestrator.sh` coordinates context collection, OpenCode
  execution, review payload creation, and submission.
- `bin/review_context` collects pull-request metadata, mentions, previous bot
  comments, review thread state when available, valid diff lines, and action
  items.
- `bin/review_comments` is the staging interface used by OpenCode and the
  orchestrator for comments, suggestions, multiline findings, replies, the
  synthesized review conclusion, listing, and status checks.
- `bin/stage_review_comment` and `bin/filter_review_comments` are compatibility
  wrappers around the review-comment tooling.
- `lib/review-tools.js` contains the shared implementation for staging,
  filtering, and validating review comments.
- `opencode/AGENTS.md` is the image-global review prompt.
- `opencode/opencode.json` configures OpenCode and reads secrets through
  environment placeholders.
- `opencode/skills/` contains vendored reviewer skills used inside the image.
- `.github/workflows/publish-image.yml` builds and publishes the image to GHCR.
- `.github/workflows/review.yml` is the reusable workflow consumed by target
  repositories.
- `examples/singular-code-review.yml` is an example trigger workflow for a
  consuming repository.
- `test/` contains Node test suites with mocked `gh` and `opencode` commands.

## Published image

Pushes to `main` publish the reviewer image to GitHub Container Registry as:

```text
ghcr.io/we-are-singular/singular-code-review-agent:latest
ghcr.io/we-are-singular/singular-code-review-agent:sha-<commit>
```

Pull requests build the image without publishing it. The source repository can
remain private while the GHCR package is made public for unauthenticated pulls
from consuming repositories.

## Runtime Inputs

The reusable workflow exposes only the pull request/comment identifiers as
inputs. It owns the GitHub App client ID, command trigger, container image,
OpenCode model, and OpenCode agent.

The orchestrator receives these required runtime environment variables from the
reusable workflow:

- `GH_TOKEN`: token used by the GitHub CLI and review submission.
- `GITHUB_REPOSITORY`: repository in `owner/name` form.
- `PR_NUMBER`: pull request number to review.
- `OPENCODE_API_KEY`: OpenCode Go API key consumed by the bundled provider
  configuration.

Optional runtime environment variables:

- `OPENCODE_MODEL`: model id used by the bundled `reviewer` agent; defaults to
  `opencode-go/minimax-m2.7`.
- `CONTEXT7_API_KEY`: optional Context7 key for higher rate limits.
- `DRY_RUN=true`: local development override that prints the final review
  payload instead of submitting it.

Dependency installation is automatic when the checked-out pull-request workspace
contains `package.json`. The runner chooses `pnpm`, `yarn`, or `npm` based on the
lockfile present in the workspace.

## Reviewer behavior

The bundled prompt in `opencode/AGENTS.md` is copied into the image as the
image-global OpenCode instructions. Target repositories can still provide their
own `AGENTS.md` files for project-specific context, but the image prompt remains
authoritative for review-only behavior.

The reviewer queues findings and replies through `review_comments` instead of
posting them directly. The orchestrator is the only submitter, which allows it
to validate positions against the current diff and submit one consolidated
review. After the finding pass, the orchestrator runs a second OpenCode pass to
synthesize the GitHub review body from the reviewer output. That body can be a
single-line LGTM for simple pull requests or a sectioned summary covering
changes, recommendations, and important flags when useful. It also tracks
previous bot comments and reply action items so follow-up review runs can
respond to existing threads when appropriate. When a top-level
`@singular-code-review` comment asks a direct question, the single review body
answers the commenter first and then continues with the review summary.

Review text should be passed with stdin or files rather than shell-quoted inline
arguments, for example:

```bash
review_comments add --path "src/app.js" --line "42" --body-stdin <<'REVIEW_COMMENT'
This preserves Markdown like `code`, "$values", and code snippets without shell escaping.
REVIEW_COMMENT
```

When GitHub review thread data is available, validation drops new inline
comments that target a line already covered by an unresolved bot thread. If
thread state is unavailable, validation still uses the REST review-comment list
to drop new bot comments on lines where the bot has already commented.

## Vendored skills

The image vendors these skills from `we-are-singular/skills` at commit
`fc5dbad9c36df9f133a1c2221ef8d1212f0c36b1`:

- `backend-architecture`
- `frontend-architecture`
- `singular-code-review`

The `git-commit-pr` skill is intentionally excluded. Vendoring keeps image
builds reproducible and avoids pulling skill content with `npx` or GitHub during
the Docker build. Update the snapshot by replacing the skill directories under
`opencode/skills/` and updating `opencode/skills/VENDORED_SKILLS.md`.

## Local development

The local test suite uses Node's built-in test runner and mocked external CLIs:

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
