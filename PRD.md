# Singular Code Review Production Runner PRD

## Purpose

Singular Code Review is a GitHub App powered pull request reviewer that runs from a reusable GitHub Actions workflow. The prototype proved the workflow, prompts, review queue, audit pass, and GitHub review submission flow. The production runner turns that prototype into a maintainable application.

The goal is not to change the reviewer behavior. The goal is to replace brittle plumbing with explicit modules, typed contracts, and a runner architecture that can be tested without live GitHub or OpenCode calls.

## Prototype Problems Addressed

- The shell orchestrator owned too many responsibilities: environment setup, dependency installation, OpenCode calls, prompt construction, JSON parsing, payload creation, body formatting, and submission.
- Bash contains too many large inline JavaScript blocks. Small inline Node snippets are acceptable for narrow local transforms, but repeated multi-line programs make the logic hard to review, test, lint, reuse, or type-check.
- OpenCode JSON parsing was hidden behind an ad hoc shell-facing adapter instead of an application client.
- Final review body handling has relied on output cleanup and banner detection. The production runner should not parse model prose with regexes to decide what is content.
- GitHub and OpenCode boundaries are not clean enough. The code should be able to run in dry mode against a real PR and report exactly what it would submit.

## Product Requirements

### Trigger Behavior

The reusable workflow must review when:

- a pull request is opened and is not a draft;
- a pull request moves from draft to ready for review;
- an authorized user posts a comment containing `@singular-code-review`;
- `workflow_dispatch` is run manually with a PR number.

The workflow must not review on every push.

For `issue_comment` triggers, the caller workflow should gate comments by author association and bot status before invoking the reusable workflow. The reusable workflow should still run its own guard because client workflows can drift.

### Review Behavior

The runner must:

- build normalized PR context, including diff ranges, comments, previous bot findings, unresolved review threads when available, trigger comment metadata, and bot login;
- run a first OpenCode review pass over the checked-out PR branch;
- let the agent queue inline comments, suggestions, and replies through structured review tools;
- validate queued comments against current diff positions before submission;
- run a queue audit pass when comments or replies were queued;
- validate again after the audit pass;
- synthesize a final review body;
- add a programmatic model banner before submission;
- submit one GitHub pull request review containing the final body and inline comments;
- submit queued replies to existing review comments;
- support dry-run execution that prints the exact review payload and replies without posting to GitHub.

### Prompt Behavior

The existing three-pass review shape stays:

1. Review pass discovers findings and queues structured review actions.
2. Audit pass edits only the queue and tightens findings.
3. Synthesis pass writes the final top-level review body.

Prompt language should describe the desired review behavior positively:

- answer direct `@singular-code-review` questions first and address the commenter by handle;
- use the structure that best fits the PR;
- summarize inline findings by theme instead of re-listing every line-level detail;
- surface severe, dangerous, security-sensitive, or merge-blocking concerns clearly;
- include practical merge guidance and severity;
- include brief praise when the PR has a sound direction or useful improvement.

The synthesis prompt should define an output contract: it produces the review body. The runner owns the model banner.

OpenCode agent files under `opencode/agents/` are durable role instructions,
similar to a system prompt. Prompt files under `src/prompts/` are phase-specific
task instructions passed to `opencode run`.

## Non-Goals

- Build a hosted SaaS runner.
- Replace the GitHub App with PATs or machine users.
- Support every possible OpenCode provider/configuration from client workflows.
- Make bot login, app client ID, or trigger command configurable unless there is a concrete need.
- Parse model prose to remove accidental chatter, duplicate banners, or guessed headings.

## Architecture

### Preferred Shape

Move production logic into a TypeScript application and keep shell scripts as thin process wrappers. The code should be organized by responsibility, not by a generic `utils` drawer. Use concrete classes or functions for the main boundaries and introduce interfaces only where there are real alternate implementations, such as live GitHub vs dry-run GitHub, or OpenCode CLI vs OpenCode SDK.

This is not a "no Bash" rewrite. Bash should own provisioning and process setup where shell is the right tool. TypeScript should own structured application behavior: GitHub API calls, review context, queue validation, prompt assembly, review payloads, dry-run state, and the high-level review pipeline. Avoid replacing clear shell with TypeScript files that only spawn child processes.

```text
review_runner
  -> /usr/local/lib/singular-code-review/dist/cli/review-runner.js

bin/provision.sh
  -> prepares the checked-out repository before review_runner starts

review_guard
review_ack
  -> typed GitHub Actions helpers for trigger guard and acknowledgment
```

### Proposed Source Layout

```text
src/
  cli/
    review-runner.ts
    review-comments.ts
    review-context.ts
    review-guard.ts
    review-ack.ts

  clients/
    github.ts
    opencode.ts

  review/
    context.ts
    queue.ts
    diff.ts
    body.ts
    types.ts
    workflow.ts

  prompts/
    review.md
    audit.md
    synthesis.md
    prompts.ts

  config/
    env.ts
    paths.ts

  lib/
    artifacts.ts
    logger.ts
    errors.ts
    json.ts
    cli-main.ts
```

This layout is intentionally shallow. Prefer a single file per domain until the file becomes genuinely hard to navigate. Split only when the split creates a clearer ownership boundary, not because a type, client, and helper could theoretically live in separate files.

Expected first implementation size:

- `review/workflow.ts` owns the named gathering, review, audit, and synthesis phases plus the durable result shape.
- `config/env.ts` owns runner config loading and defaults.
- `clients/github.ts` owns the Octokit-backed GitHub facade.
- `clients/opencode.ts` owns OpenCode execution and the narrow CLI-backed client contract.
- `review/context.ts`, `review/queue.ts`, `review/diff.ts`, and `review/body.ts` own the durable review contracts.
- `prompts/prompts.ts` loads Markdown phase prompt assets and interpolates dynamic values.
- `opencode/agents/reviewer.md` and `opencode/agents/auditor.md` own durable OpenCode agent instructions.
- `lib/artifacts.ts` and `lib/logger.ts` cover runtime infrastructure.
- `bin/provision.sh` owns repository setup such as package-manager detection and dependency installation.

If a file is still readable at 250-350 lines and has one clear responsibility, keep it together. Avoid creating folders like `clients/github/` or `review/steps/` until there are enough implementations to justify them.

### Module Responsibilities

`cli/*`

- parse command-line arguments;
- create config;
- call the application service;
- convert expected failures to process exit codes;
- contain no GitHub payload construction, OpenCode parsing, queue validation, or prompt business logic.

`review/workflow.ts`

- owns the pipeline order;
- creates the typed run state;
- invokes named gathering, review, audit, and synthesis phase functions in order;
- centralizes unexpected error handling and final logging;
- contains no GitHub API details, prompt text, or payload shaping logic.

`config/env.ts` and `config/*`

- reads environment variables;
- applies defaults;
- resolves runtime paths;
- validates config at process boundaries;
- exposes a typed `RunnerConfig`.

`clients/github.ts`

- uses Octokit for deterministic runner-owned GitHub API calls;
- fetches PR metadata, comments, reviews, and review threads;
- submits reviews and replies;
- adds trigger-comment reactions when requested;
- supports a dry-run transport.

Keep dry-run behavior in the same file unless it grows complex enough to make the live client hard to read.

`clients/opencode.ts`

- hides whether the runner uses OpenCode CLI or the SDK;
- returns explicit artifacts: text output, optional session metadata, exit status, and log paths;
- does not parse model prose;
- keeps `gh` available inside the image for OpenCode investigation even when runner-owned GitHub calls use Octokit.

Keep the first version CLI-backed. Add SDK support in this file only if it stays readable; split later if both implementations become substantial.

`bin/provision.sh`

- runs before the TypeScript review runner;
- prepares OpenCode config directories and installs committed config templates when needed;
- detects npm, pnpm, or yarn and installs target-repository dependencies;
- passes npm's `--dangerously-allow-all-scripts` during npm installs so dependency lifecycle scripts run in the reviewer sandbox;
- owns shell-native setup work such as `corepack enable`, package-manager commands, `git safe.directory`, and other environment preparation;
- keeps setup logs in the GitHub Actions output;
- exits non-zero when required provisioning fails.

Provisioning is intentionally not a TypeScript `dependency-installer.ts`. If a setup task is mostly shell commands and filesystem preparation, keep it in shell.

`review/context.ts`

- builds `review_context.json`;
- builds compact `review_auditor_context.json` for audit and synthesis;
- computes valid diff comment ranges;
- includes previous bot comments and unresolved bot threads;
- owns fallback behavior when GraphQL thread state is unavailable.

`review/queue.ts`

- owns queue schema, validation, normalization, and payload creation;
- exposes structured functions used by `review_comments`;
- contains dedupe rules that are strictly mechanical and safe:
  - exact duplicate queued comment body at the same location;
  - exact duplicate queued reply to the same target;
  - exact match to existing unresolved bot thread when thread state is available;
  - exact match to previous bot comment only as REST fallback.
- does not remove comments just because they share a line.

`review/body.ts`

- prepends the programmatic banner:

  ```text
  > reviewer · minimax-m3

  {body}
  ```

- trims leading/trailing whitespace only;
- enforces maximum review body length;
- does not detect or remove banners, chatter, headings, or model text.

`prompts/prompts.ts`

- stores the review, audit, and synthesis phase prompts as versioned Markdown assets;
- loads prompt files and interpolates dynamic values;
- avoids hardcoding long prompts inside shell strings or runner step functions.

`opencode/agents/*`

- stores durable OpenCode agent instructions separately from per-run phase prompts;
- keeps the reviewer agent focused on pull-request investigation and queueing;
- keeps the auditor agent focused on queue audit and final body synthesis without repository investigation.

`lib/artifacts.ts`

- owns runtime artifact paths and writes;
- makes dry-run and CI debugging consistent;
- keeps large text artifacts out of logs unless explicitly requested.

### Application Graph

Create dependencies once at the composition root:

```ts
const config = loadRunnerConfig(process.env, process.argv)
const logger = createLogger()
const artifacts = new ArtifactStore(config.artifacts)
const liveGitHub = createGitHubClient({ token: config.githubToken, repository: config.repository })
const github = config.dryRun
  ? createDryRunGitHubClient(liveGitHub, artifacts)
  : liveGitHub
const opencode = createCliOpenCodeClient({ logger })

await runReviewWorkflow({ config, artifacts, github, opencode, logger })
```

This keeps dependency wiring visible and makes tests straightforward: unit tests inject fake clients, while integration tests can use fake `opencode` executables or a dry-run Octokit transport.

### Public CLI Binaries

The final image should expose a small set of stable commands:

```text
review_runner
provision.sh
review_comments
review_context
review_guard
review_ack
review_dry_run
```

There are no prototype compatibility binaries. The public command surface is the production API.

### Package Layout

The project should become an explicit TypeScript package:

```text
package.json
tsconfig.json
src/
dist/
bin/
test/
```

Recommended package direction:

- use ESM for new TypeScript if OpenCode/Octokit dependencies work cleanly with it;
- expose compiled CLI entrypoints directly as image commands;
- compile TypeScript before Docker image copy;
- copy `dist/`, prompt assets, OpenCode config, vendored skills, and production commands into the image;
- keep shell-native provisioning in `bin/provision.sh`;
- keep queue, diff, context, and body behavior in `src/review/*`.

## OpenCode Integration Options

### Option A: Keep OpenCode CLI

The runner can keep calling `opencode run` from Node or Bash.

Pros:

- closest to the current working behavior;
- preserves OpenCode's shell/tool strengths;
- no local server lifecycle;
- smallest sandbox change.

Cons:

- session reuse and structured event handling stay limited by CLI output contracts;
- the adapter must be disciplined: stdout text artifact, stderr logs, exit code, optional session id only.

Rules for this option:

- no generic JSON event duck-typing loop in shell;
- no model prose cleanup;
- no large embedded JavaScript programs inside Bash;
- small inline Node snippets are acceptable when they are obviously local, shorter than extracting a helper, and not reused elsewhere;
- if JSON events are needed, parse them in `opencode.ts` with documented event types and tests.

### Option B: Use OpenCode SDK Against Local `opencode serve`

The runner starts `opencode serve` inside the same Docker container and uses the TypeScript SDK against localhost.

Pros:

- real TypeScript session/message APIs;
- better foundation for session reuse;
- cleaner application boundary;
- easier to test OpenCode calls behind an interface.

Cons:

- introduces a managed server process in the job container;
- requires readiness checks, port management, shutdown, and server log capture;
- SDK/server version compatibility becomes part of the image contract;
- more Dockerfile/runtime complexity.

Sandbox impact:

- the sandbox remains the GitHub Actions job container;
- OpenCode server, runner, repo checkout, and secrets all live inside that container;
- this does not require sending repo contents to a separate hosted runner;
- it does increase the number of trusted local processes.

### Recommendation

Start with a TypeScript runner and a CLI-backed `OpenCodeClient` interface. Keep the interface narrow enough that a later SDK-backed implementation can replace it without changing the pipeline.

After the TypeScript runner is stable, spike Option B in a separate branch:

- start `opencode serve`;
- run one review pass through the SDK;
- verify tools, permissions, files, sessions, and Context7 behavior;
- compare runtime and output reliability against CLI.

## Data Contracts

### Runtime Directory

Default:

```text
/tmp/.singular-code-review/{workspace-slug}-{workspace-hash}
```

Important artifacts:

```text
review_context.json
review_auditor_context.json
pr.diff
review_queue.json
review_validated.json
review_payload.json
opencode_review.log
opencode_audit.log
opencode_synthesis.log
```

### Review Queue

The queue remains the canonical handoff from agents to the runner:

```json
{
  "version": 1,
  "inlineComments": [],
  "replies": [],
  "conclusion": null,
  "dropped": [],
  "updatedAt": "..."
}
```

Agent-facing tools should continue supporting:

```bash
review_comments add --path file --line 10 --body-stdin
review_comments add --path file --start-line 8 --line 10 --body-file comment.md
review_comments suggest --path file --line 10 --message-stdin --replacement-file patch.txt
review_comments reply --to 123 --body-stdin
```

The runner should prefer file/stdin inputs in examples and prompts to avoid shell escaping failures.

### Final Body Contract

Synthesis output is review body text only. The runner transforms it mechanically:

```text
trim(body)
prepend("> reviewer · {model}\n\n")
submit
```

There is no sanitizer for model prose.

## Dockerfile Requirements

The image must include:

- OpenCode runtime;
- Node.js 26+ and npm 11.13+;
- `gh`;
- `git`;
- `ripgrep`;
- `python3` and build tools for target repo native dependency installs;
- Context7 MCP;
- compiled runner files;
- OpenCode config and prompts.

If the SDK/local server route is adopted, add:

- SDK dependency;
- server startup health check support;
- process cleanup on failure;
- logs for server stdout/stderr as separate artifacts.

## Testing Requirements

Testing is a final stabilization phase for this rewrite, not the first step. The current test suite mostly freezes prototype plumbing and is allowed to be deleted or retired before implementation begins. Keep only tests that protect stable product contracts and are cheap to carry forward.

Unit tests:

- queue validation;
- diff range parsing;
- GitHub payload generation;
- final body banner application;
- trigger guard decisions;
- ack idempotency;
- config defaults;
- dry-run payload output;
- OpenCode client interface with fake implementation.

Integration tests:

- local fixture PR diff and comments;
- dry-run against a real GitHub PR without posting;
- container smoke test for dependency install and runner startup;
- OpenCode fake executable/server to verify pipeline order.

Regression tests:

- shell escaping with Markdown/backticks/code snippets;
- duplicate same-line findings that are genuinely distinct;
- exact duplicate finding suppression;
- unresolved bot thread suppression;
- trigger comment answer appears before review summary;
- no review on push.

## Migration Plan

### Phase 1: Retire Prototype Plumbing

- Delete or quarantine tests that only lock in the current Bash/inline-JS implementation.
- Keep the current workflow behavior running while the new runner is built.
- Preserve useful fixtures and sample PR data, but do not spend time making every old test pass during the rewrite.
- Keep only minimal smoke checks needed to avoid breaking the image while refactoring.
- Move dependency installation and runtime setup toward `bin/provision.sh` instead of a TypeScript process wrapper.

### Phase 2: Build The TypeScript Skeleton

- Add the TypeScript package layout, build command, and executable wrappers.
- Add config, logging, artifact store, GitHub client, OpenCode client, queue, context, prompt, and body modules.
- Keep implementation direct and incomplete where needed; do not block the skeleton on exhaustive tests.

### Phase 3: Port The Pipeline

- Move orchestration order out of Bash.
- Keep OpenCode CLI behind `OpenCodeClient`.
- Move durable queue/context/payload logic into `src/review/*`.
- Move long prompt strings into `src/prompts/*`.
- Replace runner-owned `gh api` calls with Octokit.

### Phase 4: Harden Dry Run

- Add `review_runner --dry-run --repo owner/name --pr 123`.
- Ensure dry run fetches real PR context and produces local artifacts without posting comments or reviews.
- Print artifact paths and payload summary.

### Phase 5: SDK Spike Optional

- Implement SDK-backed `OpenCodeClient` against local `opencode serve`.
- Compare behavior, speed, session reuse, failure modes, and container complexity.
- Choose CLI or SDK based on evidence, not preference.

### Phase 6: Remove Prototype Plumbing

- Delete the shell-facing OpenCode adapter once runner-native CLI handling replaces it.
- Delete inline JavaScript from shell scripts.
- Remove the shell orchestrator after workflow migration.

### Phase 7: Add Final Tests

- Add focused unit tests for stable domain contracts: queue validation, diff ranges, body banner, payload generation, guard decisions, and config defaults.
- Add integration tests for the final runner pipeline with fake GitHub/OpenCode clients.
- Add one dry-run test against a fixture or real PR path that proves no GitHub writes occur.
- Avoid recreating the old broad test suite around implementation details.

## Acceptance Criteria

- Bash may contain small inline Node snippets for one-off local transforms, but not repeated or business-critical embedded programs.
- Shared JSON, GitHub, OpenCode, review queue, and payload behavior lives in tested JavaScript or TypeScript modules.
- No runner code removes or rewrites model prose based on regex guesses.
- The model banner is added programmatically exactly once by `review-body`.
- The synthesis prompt asks for review body content only; it does not ask the model to write the banner.
- Queue validation is deterministic and independently tested.
- Same-line comments are not deduped unless the full normalized location and body match.
- The runner can execute in dry-run mode without posting; live real-PR dry runs require valid GitHub and OpenCode credentials.
- The reusable workflow keeps the same public interface for client repos.
- Existing example client workflow remains small.
- Final focused tests pass locally and in the container after the implementation stabilizes.

## Implementation Decisions

- Guard and ack are typed CLI commands backed by the GitHub client.
- `review_comments` remains a standalone CLI for agent ergonomics and writes the canonical queue file.
- OpenCode stays CLI-backed behind `OpenCodeClient`; SDK/local-server support remains an optional future spike.
- Runtime artifacts include full review context, compact auditor context, diff, queue, validated queue, payload, OpenCode logs, raw JSONL logs when available, capabilities, and session ids.
- Dry-run supports current PR review flow with live GitHub reads and dry write artifacts; merged or historical PR support is out of scope until there is a concrete need.
