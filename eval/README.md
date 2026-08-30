# Model evaluations

The eval harness builds the production reviewer image, captures dry-run reviews for exact pull-request revisions, judges the output, renders reports, and aggregates repeated runs. Capture, judgment, reporting, and aggregation remain separate so raw model output is inspectable.

Runs may call paid or rate-limited providers. Start with one PR, one model, and concurrency 1. eval/runs/ and eval/cache/ are ignored because they may contain private source, PR metadata, provider telemetry, local paths, and credentials.

## Requirements

- Docker and installed repository dependencies;
- GH_TOKEN, GITHUB_TOKEN, or an authenticated GitHub CLI;
- credentials for the selected Agent provider.

The GitHub token needs read access to every input PR.

## Configure

Edit [config.ts](config.ts):

```ts
export default {
  concurrency: 1,
  provider: "opencode",
  models: ["opencode-go/deepseek-v4-flash"],
  input: [{ pr: "trpc/trpc/7262", ignoreHistory: true }],
  judge: {
    model: "opencode-go/deepseek-v4-flash",
    timeoutMs: 120_000
  }
}
```

ignoreHistory removes issue comments, reviews, review comments, and threads from model context while retaining PR metadata, commits, the filtered diff, and valid comment ranges. Use it for a fresh-review measurement.

OpenCode production uses opencode-go/deepseek-v4-flash. Codex comparison runs use provider codex with gpt-5.6-luna; the runtime sets maximum reasoning once at provider construction.

## Capture

```bash
npm run eval -- --out eval/runs/smoke
```

One-off input:

```bash
npm run eval -- \
  --no-config-input \
  --pr trpc/trpc/7262 \
  --model opencode-go/deepseek-v4-flash \
  --out eval/runs/smoke
```

Codex/Luna:

```bash
npm run eval -- \
  --provider codex \
  --model gpt-5.6-luna \
  --out eval/runs/codex-luna
```

The capture builds the current Dockerfile, prepares the exact pull-request checkout on the host, mounts it into the reviewer container, invokes the production review_runner without --publish, and records its single typed JSON result. The eval-only adapter renders:

- review.md;
- review_comments.json;
- review_stats.json;
- review_transcript.md.

The eval boundary also preserves the exact filtered diff and normalized PR context supplied to the judge. Those artifacts are observability and scoring inputs, not production workflow state.

The default targetDurationMs is advisory. reviewTimeoutMs is the larger stuck-provider safety ceiling and must not be interpreted as the expected review duration. There is no short no-output timeout because providers may be silent while producing a complete result.

Use --skip-build only when the exact reviewer image already exists. Use --base-image to test another AML Agent Sandbox explicitly. The run manifest records both image IDs so rebuilding cannot silently restore a result captured from another implementation revision.

Use --append to add missing matrix cells and --force to bypass the global review cache. Cache promotion requires a completed typed result and every canonical artifact; exit zero alone is insufficient.

### Credentials

OpenCode prefers OPENCODE_API_KEY. When it is absent, the harness stages disposable copies of the host OpenCode auth files into the isolated XDG data directory and removes them before retaining scratch.

Codex uses the host ChatGPT login. The harness copies auth.json into a disposable writable REVIEW_CODEX_HOME because Codex may refresh it, then deletes that copy in finally. It does not forward OPENAI_API_KEY or CODEX_API_KEY to a Codex run.

## Judge and report

```bash
npm run eval:judge -- --run eval/runs/smoke
npm run eval:report -- --run eval/runs/smoke
```

The judge receives the captured review, filtered diff, normalized PR context, and review telemetry. Human review threads remain outside the scoring prompt. Reports require a completed capture by default; --allow-partial renders only a diagnostic report and remains ineligible for benchmark aggregation.

Judgments are cached. Changing the rubric, prompt, judge model, or attached evidence changes judgment identity.

## Compare

```bash
npm run eval:benchmark
```

[benchmark.mjs](benchmark.mjs) aggregates completed summary.json files into an HTML report and JSON dataset. Keep the PR head, provider model, judge, ignoreHistory, and reviewer image stable when comparing revisions.

Repeated captures:

```bash
npm run eval:benchmark -- \
  --runs eval/runs/reviewer-v1 \
  --runs eval/runs/reviewer-v2 \
  --compare-runs \
  --out eval/runs/reviewer-compare.html \
  --json eval/runs/reviewer-compare-summary.json
```

--avg aggregates repeats by exact model and reasoning variant. Completed judged evidence ranks ahead of newer failed diagnostics.

## Historical benchmark context

The final fixed private ten-PR OpenCode/DeepSeek calibration completed 10/10 at 86.1/100, with 27 retained comments and a 193-second mean internal review time. The historical source reviewer completed the same ten revisions at 84.7/100, six comments, and 210 seconds, but used the provider's former model namespace. Treat that comparison as directional.

A blind corpus of ten merged public-library PR heads completed 10/10 at 85.0/100 and a 164-second mean internal time. Codex/Luna completed its fixed five at 83.0/100 but was materially slower.

The benchmark aggregator can still read historical source and AML summaries. All new captures execute the canonical production reviewer.

## Publication boundary

Commit harness code, rubric, public example configuration, documentation, and ignore files. Keep captures, caches, generated reports, Docker logs, scratch workspaces, private identifiers, human review exports, credentials, and provider tokens local.
