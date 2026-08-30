# Singular Code Review Agent

Singular Code Review Agent is an AML workflow that reviews pull requests from GitHub Actions. It gathers one immutable PR snapshot, runs six focused review lanes in parallel, consolidates their Tool-staged findings, validates every GitHub target deterministically, and publishes one batched review through a GitHub App.

This repository publishes the container image and reusable workflow used by Singular repositories. It is open source infrastructure, not yet the hosted subscription service described in [Future Work](FUTURE.md).

## Architecture

[src/review.tsx](src/review.tsx) is the complete workflow blueprint:

```
Workspace
├─ ReviewContextFiles
│  ├─ .singular-code-review/pr.md
│  ├─ .singular-code-review/pr.diff
│  └─ .singular-code-review/history.md
├─ ReviewAcknowledgement
├─ ReviewGate
│     ├─ answer | no-review
│     └─ review
│        ├─ Parallel
│        │  ├─ IntentContractLane
│        │  ├─ StandardsArchitectureLane
│        │  ├─ CodePathBugHunterLane
│        │  ├─ CorrectnessRiskTestingLane
│        │  ├─ DocumentationCommentaryLane
│        │  └─ MaintainabilityEleganceLane
│        └─ ReviewAudit
│           └─ ReviewValidation
│              └─ ReviewSynthesis
└─ ReviewPublication
```

One request-scoped [ReviewContext](src/components/review-context.tsx) holds the cached GitHub snapshot, publication boundary, [ReviewQueue](src/lib/review-queue.ts), and typed phase results. Provider and model configuration happen once when [AmlRuntime](src/run-review.tsx) is constructed; neither is passed through the component tree.

The three files under .singular-code-review/ are durable evidence for Agents, not orchestration state:

- pr.md contains the author description, refs, trigger, commits, and changed file manifest.
- pr.diff contains the filtered unified diff.
- history.md contains prior comments, reviews, threads, action items, and the chronological PR timeline.

Findings, audit decisions, validation results, and GitHub mutations stay typed and in memory.

## Review behavior

Every lane uses the shared [lane review policy](src/skills/lane.md), Context7 for material external-library questions, five read-only Tools for explicitly referenced GitHub PRs/issues/commits, and three finding Tools. The active PR remains preloaded in the evidence files, so reference Tools are self-service context rather than a second gathering path. The image also installs the public backend-architecture and frontend-architecture skills so OpenCode can load repository-relevant guidance on demand.

- add_review_comment stages a changed-line comment or fenced suggestion.
- add_review_reply stages a direct response to an existing top-level review comment.
- add_review_blocker stages the exceptional high-confidence critical concern that cannot honestly be anchored to one changed line.

Tool calls contain publication-ready author text. Lane terminal output is a short internal assessment and can never become a finding by accident.

[ReviewAudit](src/components/phases/review-audit.tsx) sees the complete staged queue but does not re-review the diff. It may merge duplicate finding IDs, lower an anchored inline severity, or drop weak, resolved, speculative, or disproportionate findings; it cannot invent a finding or rewrite its author text, evidence, or anchor. [ReviewValidation](src/components/phases/review-validation.tsx) then checks changed-line ranges, reply targets, duplicate comments, and unresolved prior bot threads with deterministic code.

The application derives the verdict from the retained typed findings:

- critical inline findings or review-level blockers produce ⛔ Block;
- high, low, or unresolved question findings produce ⚠️ Request changes;
- nit-only or empty reviews produce ✅ LGTM.

`low` is the reviewer's default recommendation to fix a concrete defect, contract problem, or material structural debt before merge even though a human may accept it with a reason. `nit` is explicitly safe to leave unchanged.

Synthesis receives that authoritative verdict and writes only the concise pull-request overview. Inline comments remain the sole home for specific findings. Request-changes and Block reviews may include a short Recommendations section that coordinates next steps without repeating the comments.

### Fast follow-up reviews

The deterministic gate uses event type, the previous bot review, Git ancestry, unresolved feedback, and the delta since the reviewed commit before starting the six lanes. It can:

- answer a direct conversational request;
- post a quick LGTM for an already reviewed head or a confidently contained response to prior feedback;
- escalate new behavior, unresolved findings, broad deltas, or uncertainty to the full review.

An explicit review or re-review request always reaches the full workflow.

## Runtime and publication

Production uses the OpenCode ACP supplied by the pinned AML Agent Sandbox with opencode-go/deepseek-v4-flash. Codex ACP with gpt-5.6-luna at maximum reasoning remains available for deliberate evaluation.

The packaged CLI runs inside the AML reviewer container. Agent permissions keep repository access read-only and disable native shell and network access; application-owned Tools provide the explicit external capabilities.

GitHub reads are gathered once by deterministic application code before any Agent starts. GitHub writes are declarative Tools backed by one idempotent action ledger. The runtime verifies that the checked-out commit matches the API snapshot before model work, publication rechecks the head, the batched review is submitted with commit_id, and prepared replies follow. An ambiguous failed mutation is never replayed. The CLI is dry-run by default and requires --publish for live mutations.

## Install

1. Install the Singular Code Review GitHub App on the target repository.
2. Add SINGULAR_CODE_REVIEW_PRIVATE_KEY and OPENCODE_API_KEY as repository or organization Actions secrets. CONTEXT7_API_KEY is optional.
3. Copy [examples/singular-code-review.yml](examples/singular-code-review.yml) to .github/workflows/singular-code-review.yml in the target repository.
4. Open a same-repository PR, mark a draft ready, push a new head, or have a trusted collaborator comment @singular-code-review.

The reusable workflow accepts npm_install: true for repositories whose review needs installed dependencies. It is disabled by default because package install scripts execute with the review credentials available.

Set the repository variable REVIEW_MODEL to override the production model. Existing OPENCODE_MODEL repository variables remain supported as a fallback. Start a PR title with [skip] or add @singular-code-review skip to the PR body to stop before App-token creation, checkout, and model execution.

## Security boundary

The example and reusable workflows reject fork heads before secrets, checkout, or dependency installation. Mention triggers require a repository owner, member, collaborator, or the pull-request author and ignore bot comments.

Keep the trigger on pull_request and issue_comment. pull_request_target would place trusted credentials next to untrusted fork code. Each accepted run mints a short-lived installation token for checkout, GitHub reads, reactions, replies, and review submission.

Investigative Agents have read-only filesystem access with native shell and network disabled. They receive the materialized review evidence, focused read-only GitHub reference Tools, and the finding Tools needed by their lane; Context7 is the explicit documentation MCP boundary. GitHub publication Tools are invoked programmatically after deterministic validation.

## Local development

```bash
npm ci
npm test
npm run lint
npm run format:check
docker build -t singular-code-review:local .
```

Run one real pull request without GitHub writes through the eval boundary:

```bash
OPENCODE_API_KEY=... npm run eval -- --no-config-input --pr owner/repository/123 --model opencode-go/deepseek-v4-flash --out eval/runs/smoke
```

The evaluator verifies the configured revision, prepares the checkout outside the image, mounts it at /workspace, and invokes the same production review_runner without --publish.

For scored real-PR runs, provider comparisons, cache rules, and reports, see the [evaluation guide](eval/README.md).

## Published image and entry points

Pushes to main publish:

```
ghcr.io/we-are-singular/singular-code-review-agent:latest
ghcr.io/we-are-singular/singular-code-review-agent:sha-<commit>
```

The image exposes:

- review_runner: the production CLI;
- review_preflight: the workflow-token fork, trust, and skip guard;
- provision.sh: optional target-repository dependency installation.

Useful source entry points:

- [src/review.tsx](src/review.tsx): complete declarative workflow;
- [src/components/lanes](src/components/lanes): modular specialist lanes;
- [src/components/phases](src/components/phases): gate, audit, validation, synthesis, and publication phases;
- [src/tools](src/tools): review-queue and focused GitHub read/write Tools;
- [src/services](src/services): GitHub API, cached session, evidence assembly, preflight, and mutation boundaries;
- [src/lib](src/lib): deterministic diff, gate, queue, payload, provider, and telemetry rules;
- [src/types](src/types): request, snapshot, phase, and final-result contracts;
- [eval](eval/README.md): real-PR evaluation framework.

## Benchmark snapshot

The migration was calibrated on fixed private and public PR corpora. The final pre-consolidation OpenCode/DeepSeek ten-PR run averaged 86.1/100 and 193 seconds of internal review time. The historical source implementation averaged 84.7/100 and 210 seconds on the same private revisions, but used the provider's former model namespace, so that comparison is directional. A separate Codex/Luna five-PR run averaged 83.0/100 and was much slower; it remains an evaluation path rather than the production default.

These are historical calibration results, not a latency SLA or a guarantee for the current provider snapshot.
