# Evaluating reviewer changes

The eval framework runs the production reviewer against exact pull-request revisions without publishing to GitHub. Our working corpus mixes private Singular pull requests with public pull requests from projects such as Next.js, TanStack Query, and tRPC. We choose changes with review history we can inspect and enough variety to exercise different review paths.

The framework measures this reviewer, with this rubric, on the code we selected. It is not a foolproof benchmark or a general model leaderboard. An LLM judge produces the score. It can miss subtle errors, reward a plausible false finding, or disagree with a human reviewer. We use it as a ruler for before-and-after changes, then read the generated reviews and compare their findings with the diff and real pull-request history.

Capture, judgment, reporting, and comparison stay separate so every score can be traced back to the review, diff, model, image, rubric, and judge that produced it.

Real runs may send private source to an external model provider and may cost money. Start with one PR, one model, and concurrency 1. Get explicit approval before sending a private corpus to a provider that has not already been approved for that run.

`eval/runs/` and `eval/cache/` are ignored. They may contain source, pull-request metadata, review text, provider telemetry, local paths, and credentials.

## How the framework works

Each matrix cell is one exact pull-request revision reviewed by one model through one reviewer image.

| Stage | Input | Result |
| --- | --- | --- |
| Capture | Pinned PR revision, reviewer image, model, and history mode | A production dry-run review plus its diff, context, transcript, findings, telemetry, and completion evidence |
| Judge | Captured review, transcript, diff, normalized PR context, and fixed rubric | A score and written assessment for each rubric question |
| Report | One completed capture run and its judgments | An HTML report and `summary.json` with scores, verdicts, findings, failures, time, tokens, and separate reviewer and judge costs |
| Compare | Completed summaries from one or more runs | A cross-run HTML report and JSON summary grouped by model, reasoning variant, or reviewer version |

The capture uses the same Docker image and `review_runner` boundary as production, but never passes `--publish`. The judge is a separate model call. Keeping those steps apart lets us inspect a weak review before deciding whether the reviewer, rubric, judge, or corpus caused the score.

## Reading the score

The judge scores 20 questions from 0 to 10. The framework averages those answers and presents the result on a 0-100 scale. The rubric covers verdict calibration, actionability, coverage, behavioral edge cases, public contracts, testing, documentation and migration surfaces, severity, hallucination control, research diligence, structure, and tone.

A corpus score is the mean across its completed pull requests. Read it alongside completion rate, material misses, false positives, finding count, review time, and reviewer cost. We treat a higher score as an improvement only when the underlying reviews contain fewer false positives and material misses and give authors better next steps.

The judge does not see the real human review thread. We inspect that history afterward to check which findings were supported, which material issues were missed, and whether the verdict was sensible. This prevents the historical answer from steering the score, but manual comparison remains part of every serious eval.

Small score changes are not proof on their own. Model output varies between attempts, the corpus reflects our work rather than every codebase, and changing the judge or rubric breaks direct comparability. Pin the corpus, keep the judge fixed, retain every attempt, and read the artifacts before claiming an improvement.

## Latest reviewer-change snapshot

On 2026-10-14, the inclusive-range candidate and the starting compaction implementation each reviewed eleven pinned revisions: a fixed ten-revision corpus plus one deletion-heavy large change. Both variants completed all eleven fresh captures and all eleven judgments. The reviewer and judge used `opencode-go/deepseek-v4-flash`, with history ignored and concurrency 1. Both images shared the same runtime parent; the control already included deleted-file compaction.

Only anonymous aggregates are published here. Private repository names, PR identifiers, titles, revisions, review excerpts, and raw artifacts remain local.

| Cohort | Judge score / 100, control → candidate | Mean reviewer time, control → candidate | Mean estimated reviewer cost, control → candidate |
| --- | ---: | ---: | ---: |
| Ten fixed revisions | 84.5 → 85.7 | 8m 32s → 8m 18s | $0.617 → $0.574 |
| One large deletion-heavy revision | 84.0 → 82.0 | 14m 23s → 11m 55s | $0.646 → $1.407 |
| All eleven | 84.5 → 85.4 | 9m 04s → 8m 38s | $0.619 → $0.650 |

Reviewer time excludes checkout, judgment, and orchestration gaps. Costs use recovered `opencode-db` usage and the committed fixed price table, exclude judge inference, and are estimates rather than billed charges. The benchmark model's rates are `[0.30, 1.20, 0.006]` USD per million input, output, and cached-input tokens. See [Cost accounting](../docs/cost-telemetry.md). These values replace the August snapshot; its earlier usage-accounting basis is not a direct cost comparator.

The candidate's mean time is 2.9% lower on the ten and 4.9% lower across all eleven. Three of its ten reviews exceeded the advisory ten-minute target, versus four for the control, and several individual reviews were slower. The large case was faster but scored slightly lower and cost more. One paired capture per revision does not establish a causal speedup, quality equivalence, or a stable cost improvement. The candidate cohort ran before the control, leaving provider load and execution-order effects uncontrolled; the judge was the same model used for review.

The candidate retained 40 comments versus 30 for the control, with no deterministic validation drops in either cohort. Manual inspection found overlapping major findings, different investigations and severity choices, and duplicate feedback in one candidate review. Comment volume and a small aggregate score change do not establish improved coverage.

The initial packaging canary failed before model execution and was retained as a diagnostic, excluded from reviewer timing. Every successful primary capture and judgment completed on its first model attempt. The images predate the final filename and Git blank-context corrections; local checks verify byte-identical raw/model patches and equivalent anchors on all eleven revisions, with dedicated regression tests for those edges. Those fixes did not receive another provider capture.

### Deterministic preparation benchmark

Ten fresh-process trials per variant at each size alternate control and candidate order. A synthetic repository contains one contiguous deleted file with fixed 54-byte source lines and a small active-file edit. Peak RSS includes session loading and diff-fragment serialization in the reviewer process; it excludes fixture generation, Git child-process RSS, and model execution.

| Deleted lines | Mean load + serialization, control → candidate | Mean peak RSS, control → candidate | Serialized diff fragment, control → candidate |
| ---: | ---: | ---: | ---: |
| 1,000,000 | 434.6 → 266.7 ms | 377.1 → 212.5 MiB | 27,556,296 → 792 bytes |
| 2,500,000 | 1,110.6 → 630.8 ms | 755.1 → 402.6 MiB | 75,556,296 → 792 bytes |

At 2.5 million deleted lines, the raw patch is 137,500,304 bytes and the model projection is 252 bytes. Each pair verifies the model-text hash, complete anchor counts and coordinate sums, and exclusions. The small fixture retains its full filtered model text. The complete raw patch still occupies memory during parsing, and fragmented changes require more ranges. This deletion-heavy fixture does not measure addition-heavy model context or lane-investigation limits.

Reproduce the preparation benchmark with separately compiled baseline and candidate code:

```bash
node eval/diff-benchmark.mjs \
  --before /path/to/baseline/dist \
  --after dist \
  --runs 10 \
  --out /tmp/diff-benchmark.json
```

The default sizes are 1,000, 1,000,000, and 2,500,000 deleted lines. `--lines` accepts a comma-separated override. Keep all trial samples; this preparation benchmark does not establish end-to-end review latency.

## Requirements

- Docker;
- installed repository dependencies;
- `GH_TOKEN`, `GITHUB_TOKEN`, or an authenticated GitHub CLI with read access to every input PR;
- OpenCode credentials.

OpenCode prefers `OPENCODE_API_KEY`. If it is absent, the framework stages disposable copies of the host OpenCode auth files in an isolated data directory and removes them before retaining scratch output.

## Configure a corpus

The committed [config.ts](config.ts) contains a small public example. Private and long-lived local corpora belong in `eval/config.local.ts`, which is ignored by Git.

```ts
export default {
  concurrency: 1,
  models: ["opencode-go/deepseek-v4.1-flash"],
  input: [
    {
      pr: "owner/repository/123",
      base: "full-40-character-base-sha",
      head: "full-40-character-head-sha",
      ignoreHistory: true,
      label: "short description of the change"
    }
  ],
  judge: {
    model: "opencode-go/deepseek-v4.1-flash",
    timeoutMs: 300_000
  }
}
```

`ignoreHistory: true` removes issue comments, reviews, review comments, and threads from the reviewer context. PR metadata, commits, the filtered diff, and valid comment ranges remain. Use this for a fresh-review measurement.

Always pin `base` and `head` for a benchmark. Capture fails when the live PR no longer matches either SHA, which prevents a moved PR head from silently changing the corpus.

## Start with a canary

Run one known PR through the current image before spending a full corpus:

```bash
npm run eval -- \
  --no-config-input \
  --pr trpc/trpc/7262 \
  --model opencode-go/deepseek-v4.1-flash \
  --concurrency 1 \
  --out eval/runs/canary \
  --force
```

The capture builds the current Dockerfile, prepares the exact checkout on the host, mounts it at the review workspace, and invokes the production `review_runner` without `--publish`.

Inspect the generated review and completion evidence before starting a matrix. A canary should prove that the expected model ran, every phase completed, findings reached the typed queue, required artifacts exist, and no GitHub write occurred.

## Run a benchmark

### 1. Capture reviews

```bash
npm run eval -- \
  --config eval/config.local.ts \
  --model opencode-go/deepseek-v4.1-flash \
  --out eval/runs/current-deepseek \
  --force
```

One capture writes:

- `review.md`;
- `review_comments.json`;
- `review_stats.json`;
- `provider_completions.jsonl` with content-free ACP run, session, model, and stop-reason evidence;
- `review_transcript.md`;
- the exact filtered diff and normalized PR context supplied to the judge.

`targetDurationMs` is an advisory performance target. `reviewTimeoutMs` is a larger stuck-provider ceiling. A provider may remain silent while producing a complete result, so there is no short no-output timeout.

Use `--append` to add missing matrix cells. Use `--force` when the purpose is to measure the current reviewer rather than reuse a prior capture. Cache promotion requires a completed typed result and every canonical artifact; exit zero is insufficient.

### 2. Judge the captured reviews

```bash
npm run eval:judge -- --run eval/runs/current-deepseek
```

The judge receives the generated review, filtered diff, normalized PR context, and review telemetry. Human review history stays outside the scoring prompt.

The judge reuses the config recorded in `run.json`, including its model and timeout. Pass `--config`, `--model`, or `--timeout-ms` only for an intentional override. Every paid attempt is retained under `judge-attempts/`; the canonical judge files point at the selected result, while reports account for all retained attempts.

### 3. Render the report

```bash
npm run eval:report -- --run eval/runs/current-deepseek
```

Reports require a complete capture by default. `--allow-partial` renders diagnostics for a running or interrupted capture, but that report remains ineligible for benchmark aggregation.

### 4. Compare runs

```bash
npm run eval:benchmark -- \
  --runs eval/runs/current-deepseek \
  --runs eval/runs/current-glm \
  --compare-runs \
  --out eval/runs/model-comparison.html \
  --json eval/runs/model-comparison.json
```

`--avg` groups repeated captures by exact model and reasoning variant. Completed judged evidence ranks ahead of newer failed diagnostics.

## Compare models fairly

Build the reviewer image once, then reuse that exact image for every model in the comparison:

```bash
npm run eval -- \
  --config eval/config.local.ts \
  --model opencode-go/deepseek-v4.1-flash \
  --out eval/runs/current-deepseek \
  --force

npm run eval -- \
  --config eval/config.local.ts \
  --model opencode-go/glm-5.3-flash \
  --out eval/runs/current-glm \
  --force \
  --skip-build \
  --image singular-code-review:eval
```

Keep these fixed across the runs:

- base and head SHAs;
- `ignoreHistory` mode;
- reviewer image ID and base image ID;
- judge model, prompt, rubric, and timeout;
- concurrency unless concurrency itself is under test.

The run manifest records both image IDs. `--skip-build` is safe only after verifying that the local tag still points at the image recorded by the first run.

Production and capture use OpenCode. Model comparisons remain explicit through `--model` and share the same provider boundary.

## What counts as a completed run

Do not accept a process exit code or a generated HTML file as proof by itself. Before quoting a score, verify:

- `run.json` marks the run complete;
- the expected number of jobs completed and none failed;
- every job has a complete typed `result.json`;
- every job has non-empty `provider_completions.jsonl` with the requested provider, model, and terminal stop reason;
- every judged job has a completed `judge.json` and retained attempt evidence;
- `summary.json` contains only completed capture and judgment results;
- the image ID in `run.json` matches the image that was intended for the run;
- no eval containers remain active.

Keep raw evidence for failed attempts. A retry can produce the selected result, but it does not erase the failed attempt's time, cost, model identity, or diagnostic value.

## Maintain the private benchmark

The ignored `eval/config.local.ts` is the local tracker for private fixed-revision corpora and known baselines. Keep it useful to the next reviewer agent:

- retain the full 40-character base and head SHAs;
- give each PR a short label that explains why it is in the corpus;
- keep old corpus arrays intact when adding a new check cohort;
- record the reviewer commit, image, sandbox version, provider model, judge model, completion count, score, time, cost, and finding count in comments;
- state whether the score predates or follows a reviewer change;
- identify the one-PR canary used before the batch;
- never move a historical pin to the PR's latest head.

When changing review behavior:

1. Read the generated review, findings, transcript, diff, and real GitHub history for each PR.
2. Classify each failure at the owner that could have prevented it: lane scope, finding text, audit calibration, deterministic validation, synthesis, judge, or missing Tool access.
3. Change prompts or code only for failure patterns demonstrated across the corpus or for one clear critical miss.
4. Run a high-signal canary that exercises the changed boundary.
5. Rerun the frozen corpus with `--force` and a new output directory.
6. Record the new result beside the old baseline instead of overwriting history.

Human history is evidence for retrospective analysis, not reviewer input. Keep it out of history-blind captures and out of the model judge. Use it afterward to measure supported findings, false positives, severity, resolved-feedback recognition, and material recall.

Do not add a skill or Tool because a reviewer mentioned it once. First prove that missing access caused the miss and that the existing filesystem, Context7, or GitHub tools could not answer the question.

## Publication boundary

Commit the eval code, rubric, public example config, documentation, and ignore rules. Keep these local:

- private repository names, PR numbers, titles, and pinned revisions;
- captures, caches, generated reports, and Docker logs;
- generated review text and finding excerpts;
- human review exports;
- local paths, credentials, auth files, and provider tokens.

Tracked documentation may publish anonymized model-level aggregates. Label reconstructed values as reconstructed and directional. Never describe an interrupted, partially judged, or historical run as a fresh result from the current reviewer.
