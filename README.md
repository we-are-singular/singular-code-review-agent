# Singular Code Review Agent

Singular Code Review Agent runs an automated pull-request review inside GitHub
Actions. It gives OpenCode the PR context and filtered diff, validates findings
against changed lines, audits the result, and publishes one batched review from
a GitHub App identity.

This repository publishes the container image and reusable workflow used by
Singular repositories. It is open source infrastructure, not a hosted review
service. Forks need their own GitHub App identity and model credentials.

## Review flow

The reusable workflow rejects fork PRs and skip directives before minting a
GitHub App token or checking out code. For accepted runs, `review_runner`:

1. gathers normalized PR context and a filtered diff;
2. optionally gates low-risk updates and direct mention questions;
3. runs the reviewer, which queues findings through `review_comments`;
4. validates comment locations against the current diff;
5. audits the queue for invalid, duplicate, or overlapping findings;
6. synthesizes the review body and publishes one GitHub review.

The gate can answer or skip a full re-review, but it never submits an approval.
Dry runs bypass it so local checks exercise the complete review pipeline.

### Incomplete-review recovery

The exploratory review has three numbered attempts:

1. configured primary model, new session;
2. configured primary model, new session;
3. configured fallback model, new session.

The fallback defaults to `opencode-go/minimax-m3`. A detected sandbox
permission denial first receives one corrective steering message in the same
session; that continuation does not consume another numbered attempt.

An attempt succeeds only when OpenCode completes conclusively and produces
findings or a terminal verdict. Nonzero exits, terminal `unknown`, and empty or
mid-investigation output advance to the next attempt. Intermediate attempts are
retained as artifacts and never published. Exhausting the policy fails the
check instead of publishing an incomplete green review.

## Model benchmark

Repeated history-blind runs against the same fixed, anonymized calibration change produced these judge-score averages:

| Model                    | Average score |
| ------------------------ | ------------: |
| DeepSeek V4 Flash `:max` |          80.0 |
| GPT-5.6 Luna `:xhigh`    |          76.5 |
| MiniMax M3               |          74.7 |
| GPT-5.6 Luna             |          71.0 |

Only aggregate values are published; source identifiers, review text, and generated reports stay local. The comparison is directional rather than a universal model ranking because the calibration change, model variant, prompt, provider, and judge all affect the result. See the [eval guide](eval/README.md) and [`eval/benchmark.mjs`](eval/benchmark.mjs) for the capture and aggregation method.

## Install

1. Install the Singular Code Review GitHub App on the target repository.
2. Add `SINGULAR_CODE_REVIEW_PRIVATE_KEY` and `OPENCODE_API_KEY` as repository
   or scoped organization Actions secrets. `CONTEXT7_API_KEY` is optional.
3. Copy [`examples/singular-code-review.yml`](examples/singular-code-review.yml)
   to `.github/workflows/singular-code-review.yml` in the target repository.
4. Open a same-repository PR, mark a draft ready, or have an `OWNER`, `MEMBER`,
   or `COLLABORATOR` comment `@singular-code-review`.

Optional repository variables:

- `OPENCODE_MODEL` selects the primary reviewer model and supports an OpenCode
  reasoning variant suffix such as `:high`.
- `OPENCODE_MODEL_FALLBACK` selects attempt three and defaults to
  `opencode-go/minimax-m3`. It follows the same variant rule.
- `OPENCODE_GATE_MODEL` selects the cheaper gate model.

Dependency installation is disabled by default. Set the reusable workflow's
`npm_install` input only for repositories whose review requires installed
dependencies.

Start a PR title with `[skip]` or add `@singular-code-review skip` to the PR
body to stop the workflow before checkout and model execution.

## Security boundary

The reviewer runs inside the consuming repository's Actions environment. The
example and reusable workflows block fork heads before secrets, checkout, or
dependency installation. Mention triggers are limited to trusted repository
roles and remain blocked for forks.

Keep the workflow on `pull_request` and `issue_comment`. Moving it to
`pull_request_target` would put trusted credentials next to untrusted fork
code. Enabling dependency installation assumes branches and write
collaborators are trusted to run install scripts with repository Actions
secrets available.

The App private key remains in the consuming repository or organization. Each
run mints a short-lived installation token for checkout, GitHub reads, replies,
and final review submission.

## Image and repository entry points

Pushes to `main` publish:

```text
ghcr.io/we-are-singular/singular-code-review-agent:latest
ghcr.io/we-are-singular/singular-code-review-agent:sha-<commit>
```

Useful entry points:

- [`.github/workflows/review.yml`](.github/workflows/review.yml): reusable
  workflow and runtime defaults
- [`src/review/workflow.ts`](src/review/workflow.ts): review orchestration
- [`src/clients/opencode.ts`](src/clients/opencode.ts): OpenCode process and
  JSONL boundary
- [`opencode/agents`](opencode/agents): durable agent roles
- [`src/prompts`](src/prompts): phase-specific prompts
- [`opencode/skills`](opencode/skills): vendored reviewer skills
- [`eval`](eval/README.md): real-PR model evaluation framework

Target repositories can supply `AGENTS.md` for project context. Bundled agent
roles remain authoritative for review, audit, and synthesis behavior.

## Local development

```bash
npm test
npm run lint
npm run format:check
docker build -t singular-code-review:local .
```

Run a real PR through the production pipeline without GitHub writes:

```bash
OPENCODE_API_KEY=... bin/review_dry_run owner/repository 123
```

The dry run clones the PR into a disposable workspace, blocks GitHub writes,
prints the review payload, and keeps diagnostic artifacts under
`/tmp/.singular-code-review/`.

For model comparisons and reports, follow the [eval guide](eval/README.md).

## Vendored skills

The image vendors `backend-architecture`, `frontend-architecture`, and
`singular-code-review` from `we-are-singular/skills`. The pinned source commit
and update instructions live in
[`opencode/skills/VENDORED_SKILLS.md`](opencode/skills/VENDORED_SKILLS.md).
