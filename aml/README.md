# AML review agent

`aml/` is the side-by-side AML rewrite of Singular Code Review. The existing
reviewer remains under `src/`; both implementations consume the same GitHub
input and can be compared through the eval harness.

## Architecture

[`review.tsx`](review.tsx) is the complete workflow blueprint:

```text
Workspace
├─ ReviewContextFiles
│  ├─ .singular-code-review/pr.md
│  ├─ .singular-code-review/pr.diff
│  └─ .singular-code-review/history.md
├─ ReviewAcknowledgement
├─ Sandbox (when supplied by the managed worker)
│  └─ ReviewGate
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

One flat [`ReviewContext`](review-context.tsx) holds the cached GitHub snapshot,
request-scoped services, staged findings, selected draft, and typed phase
results. Nested phases add only their result to that Context. Provider and
model configuration belong to the single `AmlRuntime` construction boundary in
[`runtime.tsx`](runtime.tsx); neither is passed through the component tree.

### Readable review context

[`ReviewContextFiles`](components/review-context-files.tsx) materializes three
Agent-readable inputs before investigation starts:

- `pr.md` contains PR metadata, the full author description, changed-file
  manifest, trigger, refs, and commit messages;
- `pr.diff` contains the current filtered unified diff with normal `diff --git`,
  `---`, `+++`, and hunk lines;
- `history.md` contains action items, the chronological timeline, conversation,
  submitted reviews, thread state, and previous bot findings.

These are evidence files, not a workflow message bus. Findings, phase results,
and publication state never travel through Markdown or JSON files. The logical
directory is workspace-relative so an AML Sandbox sees the same files as the
Agent. `review_dry_run` already places that disposable checkout beneath the
established `/tmp/.singular-code-review/` permission root.

### Parallel lanes and review Tools

The six modular components under [`lanes/`](lanes/) are direct children of
AML's native `<Parallel>`. Each lane receives the shared evidence-first
[`review-skill.md`](review-skill.md), read-only GitHub Tools, three finding
Tools, and one compact natural-language return:

- `add_review_comment` stages a validated inline comment or complete
  suggestion;
- `add_review_reply` answers one existing top-level review thread;
- `add_review_blocker` stages only a high-confidence critical concern that
  cannot honestly target one changed line; severity and confidence are fixed
  by the application rather than chosen by the Agent.

The lane returns one or two short internal assessment sentences instead of
serializing another result shape or spending a Tool round trip merely to end.
Exact finding retries from one lane are idempotent, while agreement from
different lanes remains visible to audit. There is no hard-coded
documentation-only classifier, custom scheduler, partial-success quorum, or
lane-result JSON contract. Native `<Parallel>` owns concurrency and any failed
lane fails the review before audit or publication.

[`ReviewFindings`](services/review-findings.ts) owns this request-local state.
[`tools/review.ts`](tools/review.ts) owns the Agent-facing Tool schemas. Adding
or removing a lane is visible in `review.tsx`, its focused lane component, and
the typed lane list.

### Audit, validation, and synthesis

[`ReviewAudit`](phases/review-audit.tsx) performs one semantic calibration only
when lanes staged findings. It receives only the staged queue and may consult
`pr.md` or `history.md` solely for accepted scope, prior feedback, and existing
threads. It cannot inspect the diff or repository, use external documentation,
or promote lane prose into a finding. It deduplicates, groups, tightens, and
recalibrates at most 24 typed findings. That limit is a hard safety ceiling,
not an output target. Audit failure is fatal; unaudited specialist output is
never promoted.

[`ReviewValidation`](phases/review-validation.tsx) then applies the existing
deterministic changed-line, reply-target, unresolved-thread, and duplicate
rules from `src/`. Audited blockers bypass only anchor validation and remain
separate from the GitHub inline/reply payload. Validation preserves typed
severity for every surviving finding so
[`ReviewSynthesis`](phases/review-synthesis.tsx) can make one small prose call
over the complete retained set while deterministic code owns the Markdown
structure and final verdict. Critical blockers are rendered under
`Recommendations`; they contribute to `⛔ Block` without replacing the summary,
other retained feedback, or verdict text. A clean result or hint/nit-only result
is LGTM; critical evidence blocks; other actionable severities request changes.

Every specialist receives the image's Context7 MCP through the shared
`ReviewLane` boundary and uses it only when current external library or
platform semantics materially settle a review claim. Audit deliberately has
no Context7 or GitHub Tools because it calibrates the staged queue instead of
investigating the pull request again.

### Deterministic publication

[`ReviewPublication`](components/review-publication.tsx) is part of the same AML
evaluation and does not start a publisher Agent. It converts the selected draft
to the existing GitHub payload, verifies that the PR head is still the inspected
commit, and invokes the exact prepared GitHub Tools programmatically.

[`ReviewGitHubActions`](services/github-actions.ts) shares one idempotent ledger
between dry-run and live execution. Duplicate calls coalesce, completed writes
are not repeated, and a rejected mutation with an ambiguous remote outcome is
never replayed. Reviews are submitted with GitHub's `commit_id`; replies run
only after the batched review succeeds.

The rewrite reuses `src/` only for deterministic domain behavior: context and
timeline projections, diff filtering, re-review gate preparation, queue
validation, body limits/banner rendering, and GitHub payload shaping. It does
not invoke the existing runner or its phase CLIs.

## Running

OpenCode with DeepSeek Flash is the normal AML configuration:

```bash
npm run build

GH_TOKEN=... \
  AML_REVIEW_MODEL=opencode-go/deepseek-v4-flash \
  npm run aml:review -- \
  --repo owner/repository \
  --pr 123 \
  --workspace /path/to/disposable-checkout
```

GitHub mutations are dry-run receipts unless `--publish` is present. Live mode
also runs the existing trusted-trigger, fork, and skip guard before AML starts.

Codex ACP with Luna remains an explicit comparison configuration; the provider
sets maximum reasoning once at construction:

```bash
GH_TOKEN=... \
  AML_REVIEW_PROVIDER=codex \
  AML_REVIEW_MODEL=gpt-5.6-luna \
  npm run aml:review -- \
  --repo owner/repository \
  --pr 123 \
  --workspace /path/to/disposable-checkout
```

The defaults are OpenCode, `opencode-go/deepseek-v4-flash`, and concurrency six.
The Dockerfile pins the published AML Agent Sandbox by digest and installs SDK
`0.7.1` through the repository lockfile. The base image supplies the Agent ACP
executables.

## Output and isolation

The CLI writes one complete `ReviewRunResult` JSON value to stdout. The eval-only
adapter in [`../eval/lib/aml-artifacts.mjs`](../eval/lib/aml-artifacts.mjs)
derives `review.md`, comments, stats, and transcript artifacts from that value.
Those outputs are observability data, not runtime state.

Investigative Agents request read-only filesystem access with native shell and
network disabled. A managed worker may inject an AML `SandboxProvider`, which
places the investigative subtree inside one declarative read-only `<Sandbox>`.
The packaged CLI does not start nested Docker because the application already
runs in the outer reviewer container.

## Validation

```bash
npm ci
npm test
npm run lint
npm run format:check
```

Credential-free tests exercise native parallelism, Tool scoping and
idempotency, context-file materialization, typed validation/verdicts, re-review
fast paths, stale-head rejection, live/dry-run parity, and ambiguous-write
safety. Live PR evals remain separate because they consume remote inference.
