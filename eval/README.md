# Model evaluations

This harness runs the production reviewer image against real pull requests, then judges and compares the captured reviews. Capture, judgment, reporting, and aggregation are separate steps so the original model output remains inspectable.

Runs may call paid APIs. Start with one PR, one model, and concurrency 1. `eval/runs/` and `eval/cache/` can contain source, PR metadata, raw model transcripts, local paths, and provider telemetry. Both directories are ignored and remain local.

## Requirements

- Docker and installed repository dependencies
- `GH_TOKEN`, `GITHUB_TOKEN`, or an authenticated GitHub CLI
- Credentials required by the selected OpenCode provider

The GitHub token needs read access to every input PR. Keep any non-public repository identifiers in an uncommitted local config.

## 1. Configure

Edit [`config.ts`](config.ts). Its committed matrix contains only public pull requests and a small model set:

```ts
export default {
  concurrency: 1,
  models: ["opencode-go/minimax-m3"],
  input: [{ pr: "trpc/trpc/7262", ignoreHistory: true }],
  judge: {
    model: "opencode-go/deepseek-v4-flash",
    timeoutMs: 120_000,
  },
}
```

Use a separate ignored config for any non-public input. Do not replace the committed public examples with internal repository or pull-request identifiers.

This reviewer version supports only `ignoreHistory: true`. It removes issue comments, reviews, review comments, and threads from model context while retaining PR metadata, commits, the filtered diff, and valid comment ranges. It measures a fresh review rather than agreement with prior discussion.

Model values are OpenCode IDs. Bare names such as `minimax-m3` normalize to `opencode-go/minimax-m3`. Check provider availability and pricing before a large matrix.

## 2. Capture

```bash
npm run eval -- --out eval/runs/smoke
```

For a one-off public input without editing config:

```bash
npm run eval -- \
  --no-config-input \
  --pr trpc/trpc/7262 \
  --model opencode-go/minimax-m3 \
  --out eval/runs/smoke
```

Capture builds the current image and runs `review_dry_run`. It records the review, validated queue, filtered diff, model contexts, phase logs, raw JSONL, finish reason, duration, tokens, and provider-reported cost. GitHub writes stay disabled.

Use `--append` to extend a run and `--force` to bypass cached captures. This version evaluates the pull request state available at capture time and rejects fixed `base` and `head` revisions rather than labeling a live review as historical. Keep the PR head stable during a comparison, and use `--force` or separate cache directories when the reviewer source or prompts change.

Run `npm run eval -- --help` for the complete capture interface.

## 3. Judge and report

```bash
npm run eval:judge -- --run eval/runs/smoke
npm run eval:report -- --run eval/runs/smoke
```

The judge receives the captured review, filtered diff, and curated runtime evidence. Human review threads remain outside the scoring prompt. The report writes `summary.json` and `report.html` with scores, verdicts, comments, duration, tokens, costs, and failures.

Judgments are cached. Use `npm run eval:judge -- --help` before changing the judge model, timeout, or cache behavior.

## 4. Compare

```bash
npm run eval:benchmark
```

[`benchmark.mjs`](benchmark.mjs) aggregates generated summaries into an HTML report and JSON dataset. Keep the PR head, model variant, judge, and `ignoreHistory` setting stable when comparing reviewer revisions.

For repeated captures of the same PR and model under different reviewer versions:

```bash
npm run eval:benchmark -- \
  --runs eval/runs/reviewer-v1 \
  --runs eval/runs/reviewer-v2 \
  --compare-runs \
  --out eval/runs/reviewer-compare.html \
  --json eval/runs/reviewer-compare-summary.json
```

`--avg` aggregates repeated captures by exact model and reasoning variant. Run `npm run eval:benchmark -- --help` for filters and output controls.

## Publication boundary

Commit the harness, rubric, public example config, documentation, and ignore files. Keep captures, caches, reports, Docker logs, scratch workspaces, non-public identifiers, human review exports, credentials, and provider tokens local.

Generated HTML and JSON reports contain pull-request references and review excerpts. They are diagnostic artifacts, not publication-ready summaries. Public comparisons must contain model-level aggregates only, with no repository names, pull-request numbers or titles, finding text, artifact links, or local paths.

Public pull requests are suitable committed calibration inputs. Dated benchmark notes and one-off launch scripts belong outside the repository.
