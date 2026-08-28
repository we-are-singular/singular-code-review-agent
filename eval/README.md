# Model evaluations

This harness runs the production reviewer image against real pull requests,
then judges and compares the captured reviews. Capture, judgment, reporting,
and aggregation are separate steps so the original model output remains
inspectable.

Runs may call paid APIs. Start with one PR, one model, and concurrency 1.
`eval/runs/` and `eval/cache/` can contain private source, PR metadata, raw
model transcripts, local paths, and provider telemetry. Both directories are
ignored and remain local.

## Requirements

- Docker and installed repository dependencies
- `GH_TOKEN`, `GITHUB_TOKEN`, or an authenticated GitHub CLI
- credentials required by the selected source or AML Agent provider

The GitHub token needs read access to every input PR. Keep real private
repository identifiers in an uncommitted local config.

## 1. Configure

Edit [`config.ts`](config.ts). Its committed matrix uses public PRs and a small
model set. A private input has the same shape:

```ts
export default {
  concurrency: 1,
  models: ["opencode-go/deepseek-v4-flash"],
  input: [
    { pr: "trpc/trpc/7262", ignoreHistory: true },
    // Replace locally; keep the real identifier out of Git.
    // { pr: "example-org/private-repository/123", ignoreHistory: true },
  ],
  judge: {
    model: "opencode-go/deepseek-v4-flash",
    timeoutMs: 120_000,
  },
}
```

`ignoreHistory: true` removes issue comments, reviews, review comments, and
threads from model context while retaining PR metadata, commits, the filtered
diff, and valid comment ranges. Use it to measure a fresh review rather than
agreement with prior discussion.

Model values are provider-qualified IDs. AML production uses
`opencode-go/deepseek-v4-flash`; an opt-in Codex capture uses
`gpt-5.6-luna` and the provider applies `max` reasoning at construction. A bare
OpenCode model uses the `opencode-go/` namespace for both implementations; a
bare Codex model remains the exact Codex catalog ID. Prefer exact IDs for
reproducible matrices, and check availability and pricing before a large run.

The default reviewer is the existing `src` implementation. The AML reviewer
is selected per capture without changing `src/`:

```bash
npm run eval -- --runner aml --model opencode-go/deepseek-v4-flash \
  --out eval/runs/aml-smoke --cache-dir eval/cache/reviews/aml-smoke
```

The fixed comparison uses the same five DAAAM revisions for
`gpt-5.6-luna`:

```bash
npm run eval -- --runner aml --aml-provider codex --model gpt-5.6-luna \
  --out eval/runs/aml-codex-luna --cache-dir eval/cache/reviews/aml-codex-luna
```

The pre-refactor fixed Codex/Luna comparison completed 5/5 at an 83.0% judged average;
it is AML-only because `src/` has no Codex ACP path. Its four uncached captures
averaged 1,407.1s and all five internal timings averaged 1,232.0s, so it remains
evaluation-only because of latency. The pre-refactor ten-PR OpenCode/DeepSeek
run also completed: AML scored 84.8/100 and `src` scored 84.7/100 on identical
revisions. AML averaged 414.2s uncached capture time and 400.4s internal review
time; `src` averaged 236.2s and 209.8s respectively. AML's 414.2s capture mean
matches the roughly 7-12 minute reference; the 90/100 quality target was not
reached. Historical Pi/Ox, fallback-model, and API-key diagnostic captures are
not comparable benchmark evidence; retain them only as labelled diagnostics.
The current simplified AML tree needs a fresh fixed-set capture before being
compared with these baselines.

Use separate output and cache directories for `src` and `aml`; the harness
also includes the runner in each job and cache identity. AML receives the same
repository and PR input, then materializes `pr.md`, `pr.diff`, and `history.md`
beneath its disposable checkout from one cached GitHub snapshot. Request-scoped
GitHub read Tools remain available for details those files do not settle. The
eval-owned snapshot and filtered diff remain at the cache/judge boundary. The
eval adapter renders AML's one typed result as
the canonical artifacts consumed by the existing judge/report steps.
`AML_REVIEW_MODEL` is passed into the reviewer container for AML entrypoint
wiring. AML uses one provider-selected attempt; production selects OpenCode,
while the Codex/Luna comparison is explicit and eval-only. The source runner
retains its own retry policy.
The exact provider model ID is installation/provider-specific; verify it before
running a paid or rate-limited matrix.

Local OpenCode captures prefer an explicit `OPENCODE_API_KEY`. When that
variable is unset, the evaluator copies the host OpenCode `auth.json` and
`account.json` into each isolated XDG data directory and removes both before
retaining scratch or returning. This keeps host login refreshes and secrets out
of the checkout, cache, and generated artifacts. The judge uses the same
ephemeral copy.

## 2. Capture

```bash
npm run eval -- --out eval/runs/smoke
```

For a one-off input without editing config:

```bash
npm run eval -- \
  --no-config-input \
  --pr trpc/trpc/7262 \
  --model opencode-go/deepseek-v4-flash \
  --out eval/runs/smoke
```

Capture builds the current image and runs `review_dry_run`. The source runner
emits the canonical review, comments, stats, and transcript; the eval adapter
renders the same views from AML's one stdout result. Both captures include the
eval-owned filtered diff and model context. The source runner also preserves
its queue, validation, phase-log, and raw JSONL diagnostics. AML keeps findings
and phase handoffs in memory; its three Markdown/diff files are read-only Agent
context, not orchestration state. GitHub writes stay disabled.

The Dockerfile and eval harness default to the published AML Agent Sandbox
image pinned by digest. To test an unreleased local sandbox, pass its tag
explicitly; the selected build argument is recorded in `run-config.json`:

```bash
npm run eval -- \
  --runner aml \
  --aml-provider codex \
  --model gpt-5.6-luna \
  --base-image aml-agent-sandbox:local-development \
  --out eval/runs/aml-codex-luna
```

Use `--skip-build` when the reviewer image has already been built. The local
AML sandbox image must provide the provider executables required by the
selected run.

The default advisory target is approximately 10 minutes (`targetDurationMs`);
it affects duration reporting only. The hard per-review safety ceiling for the
comparison is 30 minutes (`reviewTimeoutMs`). It is not the expected review
duration. The harness deliberately has no no-output timeout: a provider may
remain silent while producing a valid review, so only the total stuck-process
ceiling is enforced.

Codex/Luna uses the host ChatGPT Codex login. For each Codex job, the eval
harness stages an ephemeral writable copy of
`${CODEX_HOME:-~/.codex}/auth.json` into that job's runtime mount because Codex
may refresh the file, then deletes the copy in `finally`. It never forwards
`OPENAI_API_KEY` or `CODEX_API_KEY`, and never copies auth state into stdout,
cached artifacts, transcripts, or reports. Non-Codex runs do not receive the
Codex auth copy.

An API-key diagnostic run is invalid non-benchmark evidence: six trivial
parallel typed agents completed only 4/6 after 28 reconnects, and its trace
exposed `no credits`. Do not include that run in model, completion, latency, or
score comparisons.

Use `--append` to extend a run and `--force` to bypass cached captures. Review
cache identity includes the inspected reviewer image ID alongside the runner,
provider, model, and reviewed input, so rebuilding the image cannot silently
restore evidence from an older implementation. Keep separate output directories
for each comparison run; use `--force` only when intentionally resampling the
exact same image and input.

Run `npm run eval -- --help` for the complete capture interface.

## 3. Judge and report

```bash
npm run eval:judge -- --run eval/runs/smoke
npm run eval:report -- --run eval/runs/smoke
```

The judge receives the captured review, filtered diff, and curated runtime
evidence. Human review threads remain outside the scoring prompt. By default,
the report rejects a run that has not reached `status: completed`; use
`--allow-partial` only to render local diagnostics for an interrupted run.
Partial summaries remain ineligible for benchmark aggregation. The report
writes `summary.json` and `report.html` with scores, verdicts, comments,
timing, tokens, known costs, and failures. It keeps uncached capture wall time
separate from reviewer-reported timing: the first is comparable across runners,
while AML's internal clock covers its complete in-memory workflow and `src/`
sums model phases. Cache restoration is excluded from wall time. Cost is `n/a`
when the provider reports no charge and the exact model has no configured
price; the harness never substitutes a generic token rate.

Judgments are cached. Use `npm run eval:judge -- --help` before changing the
judge model, timeout, or cache behavior.

## 4. Compare

```bash
npm run eval:benchmark
```

[`benchmark.mjs`](benchmark.mjs) aggregates generated summaries into an HTML
report and JSON dataset. Keep the PR head, model variant, judge, and
`ignoreHistory` setting stable when comparing reviewer revisions.
Only completed run summaries are eligible. When the default aggregation sees
repeated PR/model evidence, a completed judged result stays ahead of a newer
failed diagnostic capture; freshness breaks ties between equivalent results.

For repeated captures of the same PR/model under different reviewer versions:

```bash
npm run eval:benchmark -- \
  --runs eval/runs/reviewer-v1 \
  --runs eval/runs/reviewer-v2 \
  --compare-runs \
  --out eval/runs/reviewer-compare.html \
  --json eval/runs/reviewer-compare-summary.json
```

`--avg` aggregates repeated captures by exact model and reasoning variant.
Run `npm run eval:benchmark -- --help` for filters and output controls.

## Publication boundary

Commit the harness, rubric, example config, documentation, and ignore files.
Keep captures, caches, reports, Docker logs, scratch workspaces, private
identifiers, human review exports, credentials, and provider tokens local.

Public PR examples are suitable committed calibration inputs. Dated benchmark
notes and one-off launch scripts belong outside the repository.

The historical v29 image was built from the local AML workspace at clean
revision `160ee881`; it is retained only to explain older captures. The current
blueprint runs six native Parallel lanes, stages findings through one review
Tool, performs one semantic audit with a 24-finding hard ceiling, applies the
existing deterministic queue validation, and derives the verdict from typed
retained severity. There is no separate findings judge or publisher Agent.
