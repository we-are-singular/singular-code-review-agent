# Singular Code Review Agent

Singular Code Review Agent runs an automated pull-request review inside GitHub
Actions. It gives OpenCode the PR context and filtered diff, validates findings
against changed lines, audits the result, and publishes one batched review from
a GitHub App identity.

This repository publishes the container image and reusable workflow used by
Singular repositories. It is open source infrastructure, not a hosted review
service. Forks need their own GitHub App identity and model credentials.

## Existing review flow

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

### Existing reviewer incomplete-review recovery

The `src/` exploratory review has three numbered attempts:

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

## Side-by-side AML reviewer

[`aml/review.tsx`](aml/review.tsx) contains a new AML implementation beside the
unchanged `src/` reviewer. Its main JSX tree shows acknowledgement, gate, six
specialist lanes under native `<Parallel>`, evidence audit, deterministic
validation, synthesis, and publication in one place. Before investigation,
AML writes `pr.md`, `pr.diff`, and `history.md` beneath the checkout's
`.singular-code-review/` directory. They are readable evidence, not workflow
handoffs: specialists queue validated comments, suggestions, and replies
through distinct in-memory Tools and finish through one short assessment Tool.
An exceptional blocker Tool accepts only application-fixed, high-confidence
critical concerns without an honest changed-line anchor. Audit deduplicates and
calibrates the shared findings owner before deterministic validation and
publication. There is no custom scheduler, partial-success quorum, or hard-coded
documentation-only detector; any failed native Parallel branch stops the review
before publication.

The AML runtime selects OpenCode once from the ACP executable provided by the
AML sandbox image. That is the AML implementation's normal provider/model:
`opencode-go/deepseek-v4-flash`. Evaluation may opt into AML's Codex ACP provider
with `gpt-5.6-luna` at `max` reasoning; that path is intentionally not the
production default. Review phases exchange one flat typed Context in memory;
GitHub reads, staged review findings, and prepared mutations are explicit AML
Tools. Publication invokes those Tools programmatically inside the same AML
tree and does not spend a publisher Agent turn. The `aml_review` CLI emits one
complete JSON result, while the eval harness alone renders compatibility
Markdown/JSON artifacts.

The AML reviewer is selectable in local evals and is not yet the reusable
workflow default. See [`aml/README.md`](aml/README.md) for its component tree,
provider/runtime contract, publication boundary, and local command.

Managed workers may inject an AML `SandboxProvider`. The same visible review
tree then acquires one read-only `<Workspace>` and `<Sandbox>` lease around the
complete investigative blueprint. The packaged CLI does not start nested
Docker because the application already runs in the outer reviewer container; a
managed service must own the stronger Sandbox provider at its composition
boundary.

The Dockerfile pins the published AML Agent Sandbox by immutable digest. The
application installs AML SDK `0.7.1` through its ordinary package lock, while
the base image supplies the matching CLI and Agent ACP executables.

## Model evaluation

The settled provider split is intentionally small:

- production AML: OpenCode with `opencode-go/deepseek-v4-flash`;
- opt-in evaluation: Codex ACP with `gpt-5.6-luna` at maximum reasoning.

The pre-refactor ten-PR baseline completed 10/10 with OpenCode/DeepSeek: AML
scored 84.8/100 and the unchanged `src/` reviewer scored 84.7/100 on the same
revisions. AML's mean uncached capture was 414.2s and its mean internal review
time was 400.4s; the source means were 236.2s capture and 209.8s internal review
time. These are historical benchmark averages, not a timeout or a production
SLA. The separate AML-only Codex ACP/Luna run completed 5/5 at 83.0/100, but
its four uncached captures averaged 1,407.1s and its five internal timings
averaged 1,232.0s, so it remains evaluation-only. The current simplified
architecture still needs a fresh fixed-set benchmark before its quality or
latency is compared with that baseline. See the [eval guide](eval/README.md)
for the matrix and cache rules.

## Install

1. Install the Singular Code Review GitHub App on the target repository.
2. Add `SINGULAR_CODE_REVIEW_PRIVATE_KEY` and `OPENCODE_API_KEY` as repository
   or scoped organization Actions secrets. `CONTEXT7_API_KEY` is optional.
   Codex/Luna evaluation uses the host ChatGPT Codex login, not an API-key
   credential. The eval harness stages an ephemeral writable copy of
   `${CODEX_HOME:-~/.codex}/auth.json` for Codex, removes it in `finally`, and
   never forwards API keys or copies auth state into artifacts or caches.
3. Copy [`examples/singular-code-review.yml`](examples/singular-code-review.yml)
   to `.github/workflows/singular-code-review.yml` in the target repository.
4. Open a same-repository PR, mark a draft ready, or have an `OWNER`, `MEMBER`,
   or `COLLABORATOR` comment `@singular-code-review`.

Optional repository variables:

- `OPENCODE_MODEL` selects the primary reviewer model and supports an OpenCode
  reasoning variant suffix such as `:high`.
- `OPENCODE_MODEL_FALLBACK` selects the source review's third attempt and
  defaults to `opencode-go/minimax-m3`. It follows the same variant rule.
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

Install the published AML SDK through the repository lockfile, then run the
normal checks:

```bash
npm ci
npm test
npm run lint
npm run format:check
```

The application image uses the published sandbox by default:

```bash
docker build -t singular-code-review:local .
```

See the [AML reviewer guide](aml/README.md#running) for the
provider and image contract. `--base-image` remains available in the eval
harness when testing an unreleased local AML sandbox explicitly.

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
