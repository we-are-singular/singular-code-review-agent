# Setup and configuration

Singular operates its deployed GitHub App privately and does not share its private key. Running the reviewer elsewhere requires your own App, image, model account, and runner capacity.

## Use the existing App

Repositories that can use the Singular-owned App need the App installed plus these Actions secrets:

- `SINGULAR_CODE_REVIEW_PRIVATE_KEY` for the App;
- `OPENCODE_API_KEY` for the production model;
- `CONTEXT7_API_KEY` when higher Context7 limits are needed.

Copy [examples/singular-code-review.yml](../examples/singular-code-review.yml) into the target repository under `.github/workflows/`. The workflow handles opened PRs, ready-for-review drafts, new heads, manual dispatches, and `@singular-code-review` comments from repository owners, organization members, and collaborators.

## Create your deployment

1. Fork this repository.
2. Create a GitHub App with `Contents: read`, `Issues: write`, and `Pull requests: write`, then install it on the repositories you want reviewed.
3. Update the App client ID and container image in [.github/workflows/review.yml](../.github/workflows/review.yml). The image should point at your fork's GHCR package.
4. Update the reusable-workflow owner in [examples/singular-code-review.yml](../examples/singular-code-review.yml) from `we-are-singular` to your GitHub owner. Set `runner` to `ubuntu-latest` or a runner label you operate.
5. If you rename the bot, change the mention and default bot login in [src/services/review-evidence.ts](../src/services/review-evidence.ts), then update the example workflow trigger.
6. Push to your fork's `main` branch to publish `ghcr.io/YOUR_OWNER/YOUR_REPOSITORY:latest`.
7. Store your App private key and model credentials as repository or organization secrets in each consuming repository, then copy your edited trigger workflow there.

The consuming repository receives a short-lived installation token during each run. It does not receive a long-lived GitHub token. You own the App, private key, image, model account, runner capacity, and any changes to the review policy.

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

Inline severity labels include emoji by default. Set the repository variable `REVIEW_EMOJIS` to `false` to render plain severity labels instead.

The runner writes concise review progress to standard error while keeping its complete JSON result on standard output. Progress includes the main review components, Agent turn boundaries, durations, and each completed turn's response. It excludes framework plumbing, trace identities, prompts, streamed reasoning, and usage payloads. In GitHub Actions, the completed result also produces a job summary with model, turns, available token usage, review counts, and publication status.

Dependency installation is opt-in because package scripts run with the review job's credentials available. Enable it only for trusted repositories where installed dependencies materially improve the review.

Start a PR title with `[skip]`, or put `@singular-code-review skip` on its own line in the PR body, to stop before App-token creation, checkout, dependency installation, and model work.

## Dry runs

The CLI is dry-run by default; live GitHub mutations require `--publish`. Use the [evaluation commands](../eval/README.md) to prepare a pinned checkout and inspect a real review without publication. Private source may still reach the configured model provider. Keep private inputs and captures in the ignored evaluation directories.

## Images and rollback

Successful pushes to `main` publish:

```text
ghcr.io/we-are-singular/singular-code-review-agent:latest
ghcr.io/we-are-singular/singular-code-review-agent:sha-<commit>
```

Version tags publish matching image tags. The final pre-[AML](https://agent-markup-language.com/) reviewer is frozen as the manually published `legacy` tag with a matching [.github/workflows/review-legacy.yml](../.github/workflows/review-legacy.yml). Normal pushes do not update it. It is a rollback path for Singular's existing deployment and does not receive new review features.
