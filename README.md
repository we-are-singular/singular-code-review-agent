# Singular Code Review

Singular Code Review is the pull-request reviewer we run on our own repositories at [Singular](https://github.com/we-are-singular). It reads the code around a diff, gives the change to six focused reviewers, audits their findings, and publishes one GitHub review.

The reviewer is written with [Agent Markup Language (AML)](https://agent-markup-language.com/). The review tree is declarative; TypeScript owns the GitHub snapshot, finding queue, validation, verdict, and publication.

> [!IMPORTANT]
>
> Singular operates the deployed GitHub App privately. Its private key is not shared. To run this reviewer outside Singular, fork the repository, create your own GitHub App, publish your own image, and point your repositories at your fork.

## Why we built it

At Singular, this is our alternative to adding another paid code-review service or coding assistant to every repository. Reviews run on our own hardware and GitHub runners, and we can move between free and inexpensive models without changing the review contract. It has already saved us thousands of euros in reviewer costs.

We are building the engine in public so anyone can inspect the review policy, model boundaries, GitHub safety checks, and evals used to change them. The eventual goal is a hosted product where someone installs an App, chooses a repository, and does not operate the reviewer themselves. The control plane is still future work; its scope lives in [Future Work](FUTURE.md).

## What a review produces

A full run publishes:

- specific problems as comments on changed lines;
- replies beside existing review threads when the author asked there;
- a short top-level summary that does not repeat every inline comment;
- one application-derived verdict: `⛔ Block`, `⚠️ Request changes`, or `✅ LGTM`.

Follow-up events do not always need another full review. The gate can answer a direct question or return a quick `✅ LGTM` when the current head was already reviewed and the new change is safely contained.

## How a review runs

```mermaid
flowchart TB
    event["PR event, workflow dispatch,<br/>or trusted @mention"] --> preflight{"Preflight"}
    preflight -->|Reject| stop["Stop before App token,<br/>checkout, or model call"]
    preflight -->|Accept| snapshot["Freeze the PR head and gather<br/>one GitHub snapshot"]

    subgraph review["src/review.tsx"]
      direction TB
      context["Materialize pr.md, pr.diff,<br/>history.md, and issues.md"] --> acknowledgement["Acknowledge the request<br/>(best effort)"]
      acknowledgement --> router{"ReviewRouter"}
      router -->|Gate: answer or safe follow-up| publication
      router -->|Gate: full review| parallel["Parallel: six specialist lanes"]
      parallel --> queue["ReviewQueue: typed findings"]
      parallel --> audit
      queue --> audit["ReviewAudit: merge, demote, drop"]
      audit --> finalization["ReviewQueue: finalize anchors,<br/>reply targets, duplicates"]
      finalization --> synthesis["ReviewSynthesis: summary,<br/>next steps, and verdict"]
      synthesis --> publication["ReviewPublication: verify head<br/>and execute one plan"]
    end

    snapshot --> context
    publication --> github["GitHub review, thread replies,<br/>or issue comment"]
```

The `src/review.tsx` section maps directly to the component tree in [src/review.tsx](src/review.tsx):

```tsx
<Workspace>
  <ReviewContextFiles />
  <ReviewAcknowledgement />
  <ReviewRouter>
    <ReviewSynthesis>
      <ReviewAudit>
        <Parallel>
          <IntentContractLane />
          <StandardsArchitectureLane />
          <CodePathBugHunterLane />
          <CorrectnessRiskTestingLane />
          <DocumentationCommentaryLane />
          <MaintainabilityEleganceLane />
        </Parallel>
      </ReviewAudit>
    </ReviewSynthesis>
  </ReviewRouter>
  <ReviewPublication />
  <ReviewUsageCollection />
</Workspace>
```

AML reads the model tree from the leaves back to the trunk. The nesting defines the review and publication boundaries:

- `<Parallel>` makes the six investigations concurrent and fails the review if any lane fails. Native fragments keep each authored heading and lane in one branch; every lane records typed findings through Tools and returns a short terminal handoff.
- `<ReviewAudit>` explicitly resolves all six children before it freezes the staged queue. It skips the audit Agent when no finding exists and otherwise gives that Agent the ordered lane handoffs, read-only full-comment lookup, and the merge, demote, and drop queue Tools.
- Finding anchors and reply targets are validated when lane Tools add them. `<ReviewSynthesis>` finalizes duplicate and prior-comment handling directly from the queue, runs the typed synthesis Agent, derives the verdict, and returns the composed JSX body to its parent.
- `<ReviewRouter>` is the intentional conditional boundary. It obtains the deterministic or typed gate decision, evaluates only the selected route, and completes one routed body through the request Context API.
- AML evaluates `<ReviewPublication>` next in authored order. Publication reads the completed route, derives the publication draft from it and the queue, verifies that GitHub still points to the reviewed commit, and executes one deterministic write plan.

The shared review Context carries request-scoped dependencies plus small APIs for the typed queue, completed routing handoff, and final publication outcome. Its top-level value is not reactive state: components share the same request binding, and mutable workflow transitions remain behind the owning APIs. Audited and validated snapshots are derived from the queue where they are consumed instead of being copied into phase-owned Context fields.

The [AML source is on GitHub](https://github.com/we-are-singular/aml). Its `Agent`, `Block`, `File`, `Include`, `Parallel`, `Tool`, and `Workspace` components describe the model-facing work without taking ownership of trusted application state. See [Architecture](docs/architecture.md) for the request-context and snapshot details.

### The six lanes

| Lane | Question it owns |
| --- | --- |
| Intent and contract | Does the patch satisfy the stated requirement and the strongest active repository contract? |
| Standards and architecture | Does it follow package ownership, canonical sources, repository rules, and established design? |
| Code-path bugs | Can a changed value or state transition break a real caller or consumer? |
| Correctness, risk, and testing | Are security, authorization, data integrity, compatibility, concurrency, rollout, performance, and tests adequate? |
| Documentation and commentary | Do active docs, examples, release guidance, and non-obvious comments still tell the truth? |
| Maintainability and elegance | Is the change locally clear, well placed, and free of needless concepts or indirection? |

Each lane can read the checkout and the same frozen PR evidence. Agents have read-only filesystem permissions, no native shell, and no native network access. Context7 and narrow read-only GitHub tools are available when the change depends on external documentation or linked GitHub evidence. Findings reach the author only through typed review tools.

OpenCode's native permission rules deny lookups targeting directories outside the checkout, with exceptions for the image's pinned architecture skills and inputs staged by AML for that Agent. A denied lookup lets the Agent narrow its search and continue the review.

PRs above 10,000 total added and deleted lines use a local diff of the pinned base/head commits, with only deletion headers shown for wholly deleted files. Historical source inspection is not available through unrestricted shell; a future bounded file-inspection tool must provide that evidence. The application retains complete changed-line ranges for comment validation. Smaller PRs keep their full filtered diff; if GitHub rejects a diff as too large, local Git supplies it without changing the compaction threshold. If local reconstruction is unavailable for a large PR, a complete GitHub diff is used uncompacted, and the review fails only when GitHub also cannot serve it.

Canonical comment anchors remain complete and use compact inclusive ranges internally. Inventories retain exact line counts, and validation rejects comment spans that cross missing diff lines. See [Architecture](docs/architecture.md#the-six-lanes) for the representation and large-diff limits.

The snapshot includes closing issue requirements and explicitly related issue and PR descriptions, decisions, commits, and discussion history. Related PR enrichment stops after one hop. Closing issues define claimed requirements; related references supply context. Publication rechecks their timestamps and PR heads.

### Model judgment and application authority

| Model work                          | Application work                              |
| ----------------------------------- | --------------------------------------------- |
| Classify an ambiguous follow-up     | Reject untrusted triggers and fork heads      |
| Investigate the six review concerns | Freeze one PR head and snapshot               |
| Audit staged findings               | Own the typed finding queue                   |
| Write the short review summary      | Validate anchors, replies, and duplicates     |
| Suggest useful next steps           | Derive the verdict and GitHub payload         |
|                                     | Verify the head and execute idempotent writes |

Models investigate and write. They do not decide which commit was reviewed, whether a comment can be posted, what verdict a severity produces, or whether a GitHub mutation should be retried.

## Run it

### Use it locally before pushing

You do not need to deploy the GitHub App to use the review policy while you work. The [singular-code-review skill](https://www.skills.sh/we-are-singular/skills/singular-code-review) packages the same review guidelines and checks into a `SKILL.md`, so a skill-compatible coding agent can inspect the local diff before it reaches the repository.

```bash
npx skills add https://github.com/we-are-singular/skills --skill singular-code-review
```

Use the skill "at home" to catch problems before pushing; the GitHub App handles the full pull-request review and publication pipeline.

### Inside Singular

Repositories that can use the Singular-owned App need the App installed plus these Actions secrets:

- `SINGULAR_CODE_REVIEW_PRIVATE_KEY` for the App;
- `OPENCODE_API_KEY` for the production model;
- `CONTEXT7_API_KEY` when higher Context7 limits are needed.

Copy [examples/singular-code-review.yml](examples/singular-code-review.yml) into the target repository under `.github/workflows/`. The workflow handles opened PRs, ready-for-review drafts, new heads, manual dispatches, and `@singular-code-review` comments from repository owners, organization members, and collaborators.

### Fork it and make it yours

Fork this repository, create and install a GitHub App, and configure your fork's image and reusable-workflow references. You own the App private key, model account, runner capacity, and review policy; consuming repositories receive short-lived installation tokens.

The [setup guide](docs/running.md#create-your-deployment) covers App permissions, workflow edits, runner selection, secrets, image publication, and bot renaming.

## Configuration

The reusable workflow accepts:

| Input                | Default         | Purpose                                              |
| -------------------- | --------------- | ---------------------------------------------------- |
| `pr_number`          | required        | Pull request to review                               |
| `trigger_comment_id` | empty           | Trusted comment that requested the run               |
| `runner`             | `ubuntu-latest` | GitHub Actions runner label                          |
| `npm_install`        | `false`         | Install target-repository dependencies before review |

Set the repository variable `REVIEW_MODEL` to override `opencode-go/deepseek-v4.1-flash`. The older `OPENCODE_MODEL` variable remains compatible.

If the primary model fails before producing a publishable review, the workflow retries once with `opencode-go/glm-5.3-flash`. Each attempt has a 20-minute limit. Set `REVIEW_FALLBACK_MODEL` to override the fallback; the older `OPENCODE_MODEL_FALLBACK` variable remains compatible. Publication failures and timeouts do not trigger the fallback because their GitHub mutation outcome may be ambiguous.

Both variables must name a model that the image's OpenCode advertises. Each attempt fetches OpenCode's Models.dev catalog once from `OPENCODE_MODELS_URL` (default `https://models.opencode.ai`, which serves Models.dev's `api.json`) and every Agent reads that copy, so all lanes offer the same models. OpenCode hides deprecated models, and alpha models unless `OPENCODE_ENABLE_EXPERIMENTAL_MODELS` is set. An `opencode` or `opencode-go` model that the catalog lacks or hides stops the attempt before review work, so the workflow moves to the fallback model. If the catalog cannot be fetched within 5 seconds, the runner logs a warning and each Agent refreshes its own catalog, using OpenCode's bundled snapshot until that refresh completes. The default and fallback models are both present in the image's bundled catalog. Setting `OPENCODE_MODELS_PATH` or `OPENCODE_DISABLE_MODELS_FETCH` yourself skips both the fetch and the early model check; OpenCode then reads that file or its bundled snapshot.

Inline severity labels include emoji by default. Set the repository variable `REVIEW_EMOJIS` to `false` to render plain severity labels instead.

The runner writes review progress to standard error and its complete JSON result to standard output. GitHub Actions adds a job summary with the model, turns, available usage, findings, and publication status. The [setup guide](docs/running.md#configuration) explains the output and configuration options.

Dependency installation is opt-in because package scripts run with the review job's credentials available. Enable it only for trusted repositories where installed dependencies materially improve the review.

Start a PR title with `[skip]`, or put `@singular-code-review skip` on its own line in the PR body, to stop before App-token creation, checkout, dependency installation, and model work.

## Trust and failure boundaries

- The caller and reusable workflow reject fork pull requests before trusted credentials reach PR code.
- Mention triggers accept repository owners, organization members, and collaborators, and reject PR-author mentions without one of those trusted associations.
- The workflow uses `pull_request` and `issue_comment`, never `pull_request_target`.
- OpenCode project configuration is disabled so reviewed files cannot start repository-defined plugins or MCP processes with review credentials.
- Every model phase sees the same cached GitHub snapshot and filtered diff.
- A failed lane, audit, queue finalization, synthesis, or model run leaves no publishable review.
- The CLI is dry-run by default; live GitHub mutations require `--publish`.
- Publication checks the PR head again and does not replay an ambiguous failed mutation.

Pull request text, comments, diffs, repository files, and linked GitHub content are untrusted evidence. They cannot grant tools or change the review contract.

## Calibration snapshots

We maintain an eval framework that runs the reviewer against a corpus of private Singular pull requests and public pull requests from well-known open-source libraries. Each run captures a review without publishing it and uses an LLM judge to score the result.

It is not a foolproof benchmark. The corpus reflects the code and review problems we care about, and LLM-as-judge has its own blind spots. It gives us a useful ruler for checking whether changes to the reviewer improve review quality without making reviews slower or more expensive.

### Model snapshots

Actual 30-minute review timeouts count as zero; other errors remain unscored. Time and reviewer cost average completed reviews, excluding judge inference and failed-attempt spend. Each row is that model's latest calibration snapshot. Reviewer revisions, judges, usage accounting, time limits, and concurrency vary across snapshots, so these are not controlled comparisons.

| Model                      | Score |    Time |             Cost |
| -------------------------- | ----: | ------: | ---------------: |
| GLM 5.3 Flash              |  87.8 |  5m 43s |          $0.0108 |
| Qwen3.8 Flash              |  86.0 | 11m 15s |          $0.2425 |
| DeepSeek V4.1 Flash        |  84.7 |  7m 17s |          $0.2145 |
| Space Bunny                |  84.5 |  1m 47s |          $0.1338 |
| LongCat 2.5 Preview        |  83.8 | 10m 46s | $0 (promotional) |
| HY3                        |  83.0 |  3m 23s |          $0.0307 |
| GPT-5.6 Luna `xhigh`       |  76.5 | 17m 14s |          $0.0838 |
| Muse Spark 1.3 Contributor |  76.4 |  1m 05s |          $0.0247 |
| MiniMax M3                 |  74.7 |  9m 42s |          $0.6012 |
| MiMo V2.6 Flash            |  31.9 | 17m 57s |          $0.1621 |

## Local development

Requirements:

- Node.js 26 or newer;
- Docker;
- an authenticated GitHub CLI or `GH_TOKEN`/`GITHUB_TOKEN` for eval inputs;
- credentials for any model used by a real review.

```bash
npm ci
npm test
npm run lint
npm run format:check
docker build -t singular-code-review:local .
```

Run one real pull request through the production review boundary without publishing to GitHub:

```bash
OPENCODE_API_KEY=... npm run eval -- \
  --no-config-input \
  --pr trpc/trpc/7262 \
  --model opencode-go/deepseek-v4.1-flash \
  --out eval/runs/smoke
```

The evaluator prepares the exact checkout outside the image, mounts it into the review workspace, and invokes `review_runner` without `--publish`.

## Images and rollback

Successful pushes to `main` publish:

```text
ghcr.io/we-are-singular/singular-code-review-agent:latest
ghcr.io/we-are-singular/singular-code-review-agent:sha-<commit>
```

Version tags publish matching image tags. The final pre-[AML](https://agent-markup-language.com/) reviewer is frozen as the manually published `legacy` tag with a matching [.github/workflows/review-legacy.yml](.github/workflows/review-legacy.yml). Normal pushes do not update it. It is a rollback path for Singular's existing deployment and does not receive new review features.

## Documentation

- [Setup and configuration](docs/running.md): GitHub App, workflows, credentials, models, images, and rollback.
- [Architecture](docs/architecture.md): AML composition, finding ownership, evidence, and safety.
- [Evaluation](eval/README.md): capture, judge, compare, and reproduce benchmarks.
- [Cost accounting](docs/cost-telemetry.md): usage recovery, price estimates, and billing limits.
- [Product contract](PRD.md) and [Future work](FUTURE.md): current guarantees and planned capabilities.
