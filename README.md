# Singular Code Review Agent

This repository is the source package for a containerized OpenCode PR reviewer.
The built image runs inside a GitHub Actions job container, reviews a pull request
diff, stages inline comments through a local tool, filters comments to valid
RIGHT-side changed lines, and submits one batched GitHub review.

## Layout

- `Dockerfile` builds the reviewer image.
- `bin/review_context` collects normalized PR context, mentions, previous bot comments, valid diff lines, and action items.
- `bin/review_comments` is the local tool OpenCode calls to queue inline comments, multiline comments, suggestions, and replies.
- `bin/stage_review_comment` and `bin/filter_review_comments` are compatibility wrappers.
- `bin/review_orchestrator.sh` fetches the PR diff, runs OpenCode, builds the review payload, and posts it.
- `opencode/AGENTS.md` contains the review-only operating instructions.
- `opencode/skills/` contains vendored reviewer skills copied into the image.
- `.github/workflows/publish-image.yml` builds and publishes this image to GHCR.
- `examples/singular-code-review.yml` is a reference workflow for consuming repositories.
- `test/` contains no-network tests with mocked `gh` and `opencode`.

## Build

The default base image is your known working OpenCode sandbox image:

```bash
docker buildx imagetools inspect docker.io/cloudflare/sandbox:0.9.2-opencode
docker build -t opencode-reviewer:local .
```

If you verify a newer compatible OpenCode sandbox tag, override the base:

```bash
docker build \
  --build-arg BASE_IMAGE=docker.io/cloudflare/sandbox:<tag> \
  -t opencode-reviewer:local .
```

## Publishing

This repository publishes its container image with `.github/workflows/publish-image.yml`.
On pushes to `main`, it builds and pushes:

```text
ghcr.io/we-are-singular/singular-code-review-agent:latest
ghcr.io/we-are-singular/singular-code-review-agent:sha-<commit>
```

Pull requests build the image without pushing it.

The source repository can be private while the GHCR image is public. After the
first successful push creates the package, set the package visibility to public
in GitHub Packages settings if you want consumer repositories to pull it without
authentication.

## Runtime Configuration

Credentials are injected at runtime, not baked into the image.

Required environment variables:

- `GH_TOKEN`: token used by `gh`.
- `GITHUB_REPOSITORY`: repository in `owner/name` form.
- `PR_NUMBER`: pull request number.
- `OPENCODE_API_KEY`: OpenCode Go API key consumed by the `opencode-go` provider config.

Optional environment variables:

- `OPENCODE_MODEL`: model id used for OpenCode's configured agents; defaults to `opencode-go/minimax-m2.7`.
- `CONTEXT7_API_KEY`: optional Context7 key for higher rate limits; anonymous usage has lower limits.
- `OPENCODE_AGENT`: agent name for `opencode run`; defaults to `coder`.
- `REVIEW_BODY`: body text for the submitted GitHub review.
- `DRY_RUN=true`: print the final payload instead of submitting it.
- `REVIEW_BOT_LOGIN`: bot login used to identify previous bot findings and reply action items.
- `OPENCODE_REVIEW_COMMAND`: PR comment command; defaults to `/singular-code-review`.

The committed `opencode/opencode.json` uses OpenCode's documented
`{env:VARIABLE_NAME}` placeholders, so GitHub secrets remain scalar values
instead of whole JSON blobs.

Dependency installation is automatic when the checked-out PR workspace contains
`package.json`. The runner uses `pnpm`, `yarn`, or `npm` based on the lockfile.

## Skills

The image vendors these skills from `we-are-singular/skills` at commit
`fc5dbad9c36df9f133a1c2221ef8d1212f0c36b1`:

- `backend-architecture`
- `frontend-architecture`
- `singular-code-review`

The `git-commit-pr` skill is intentionally excluded.

Vendoring keeps Docker builds reproducible and avoids pulling skill content with
`npx` or GitHub during the image build. To update the snapshot, replace the
three skill directories under `opencode/skills/` and update
`opencode/skills/VENDORED_SKILLS.md`.

## Initial Prompt

The reviewer workflow prompt lives at `opencode/AGENTS.md` and is copied into
`/root/.config/opencode/AGENTS.md` in the image. A target repository checkout
under `/github/workspace` can have its own `AGENTS.md`; that file does not
overwrite the image-global prompt. Repository instructions are useful context,
but the image prompt explicitly keeps review-only behavior authoritative.

## Agent Tools

The agent should start with:

```bash
review_context
```

It queues review output with:

```bash
review_comments add --path src/foo.ts --line 42 --body "Concrete finding."
review_comments add --path src/foo.ts --start-line 40 --line 44 --body "Multiline finding."
review_comments suggest --path src/foo.ts --start-line 40 --line 44 --message "Use the existing guard." --replacement-file /tmp/suggestion.txt
review_comments reply --to 123456789 --body "This is still reproducible because..."
review_comments list
review_comments status
```

The agent may use `gh` for read-only investigation, but the orchestrator is the
only submitter. It validates queued items against the current diff and posts one
batched review plus any queued replies.

## Local Tests

The tests use only Node built-ins and mocked CLIs.

```bash
npm test
```

## GitHub Actions

Copy `examples/singular-code-review.yml` into a consuming repository as
`.github/workflows/singular-code-review.yml` to trigger
reviews from PR comments containing `vars.OPENCODE_REVIEW_COMMAND`, defaulting
to `/singular-code-review`.

A GitHub App can provide the posting identity and token, but review requests are
for user logins and team slugs. Treat app mentions as text commands in PR
comments rather than relying on assigning the app as a reviewer.

Set secrets for runtime keys:

- `OPENCODE_REVIEW_APP_PRIVATE_KEY` for the GitHub App that will author reviews
- `OPENCODE_API_KEY` for OpenCode Go
- `CONTEXT7_API_KEY` if higher Context7 limits are needed

Optional repository variable overrides:

- `OPENCODE_MODEL`, defaults to `opencode-go/minimax-m2.7`
- `OPENCODE_REVIEW_COMMAND`, defaults to `/singular-code-review`
- `SINGULAR_CODE_REVIEW_CLIENT_ID`, defaults to `Iv23liVgvy1yaHapd0Wx`

The GitHub App should be installed on the consuming repository with:

- Contents: read
- Issues: read
- Pull requests: write

`examples/singular-code-review.yml` mints an installation token with
`actions/create-github-app-token` and uses that token for checkout, `gh`, and
review submission. This keeps compute inside GitHub Actions while comments are
authored by the app bot, for example `your-app[bot]`, instead of
`github-actions[bot]`.
