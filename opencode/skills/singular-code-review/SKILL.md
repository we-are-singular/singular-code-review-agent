---
name: singular-code-review
description: Use when reviewing code changes, pull requests, branches, or work-in-progress diffs for correctness, intent fit, repo-local architecture, surrounding-code pattern mismatches, maintainability, naming, tests, and over-engineering. Runs a git-heavy, subagent-oriented review that reads local AGENTS.md/docs/plans/conversation/PR context before judging the diff.
---

# Singular Code Review

Review code as a senior engineer validating whether a change should land. Start from the diff, but do not stay there: read surrounding code, local standards, linked plans/issues, PR body, commit messages, and conversation history when available.

This skill is designed for subagent orchestration. If the current environment supports subagents and the invocation permits delegation, spawn every review lane from `references/subagent-prompts.md` in one assistant turn so independent lanes run in parallel. If subagents are unavailable or not permitted, run the same lanes sequentially and keep their notes separated before synthesis.

## Read These References

- `references/git-context.md` - use for base detection, PR/branch scope, and read-only git commands.
- `references/singular-review-lens.md` - load before judging architecture, naming, maintainability, backend/frontend fit, or "elegance".
- `references/subagent-prompts.md` - load when spawning subagents, or when running lanes sequentially.
- `references/output.md` - load before the final report.

If available, also load local architecture skills when the diff touches their domain:

- `backend-architecture` for TypeScript/Node.js backend code: APIs, services, repositories, workers, integrations, SDKs, database packages, middleware, config DSLs, and backend tests.
- `frontend-architecture` for TypeScript frontend code: React, Astro, Next.js, shared UI, query hooks, client stores, forms, routing, styling, analytics, and frontend tests.

Prefer those skill bodies over the shorter fallback lens in `references/singular-review-lens.md`. If a skill registry is unavailable but this repository or installed skill set has `skills/backend-architecture/SKILL.md` or `skills/frontend-architecture/SKILL.md`, read the relevant file directly.

Optional helper:

```bash
bash skills/singular-code-review/scripts/collect-review-context.sh [base-ref]
```

Resolve the script path relative to this skill folder when installed elsewhere. The helper is read-only and prints scope, changed files, diff stats, untracked files, and relevant local docs near changed files.

## Non-Negotiables

- Review-first by default. Do not edit, commit, push, open PRs, or file tickets unless the user explicitly asks for fixes.
- Do not run destructive git commands: no `git reset`, `git checkout --`, branch deletion, force push, or cleanup.
- Do not switch branches just to review a PR. A PR URL/number selects review scope, not permission to mutate the checkout.
- Do not trust stale workspace files for remote PRs or remote branches. If the working tree is not the reviewed head, inspect with `gh pr diff`, `git show <head-ref>:<path>`, or fetched review refs.
- Do not stop at the diff. For every meaningful finding, check callers, tests, neighboring modules, local docs, generated contracts, and parallel patterns.
- Do not report style noise that a formatter/linter owns unless the project docs explicitly make it a review rule.
- When intent is missing and the change is not self-explanatory, flag that as a review finding or coverage risk. Undocumented non-obvious changes are reviewable.

## Workflow

### 1. Determine Scope

Use `references/git-context.md` for exact commands.

Always establish:

- Review target: PR, branch, explicit base, staged diff, unstaged diff, or commit range.
- Diff base and scope mode: local working tree, local-aligned PR, remote PR, or remote branch.
- Changed files, rename/copy information, diff stat, numstat, and untracked files.
- Whether the diff is mechanical, generated, dependency-only, or mixed with substantive code.

If the review target is ambiguous and no diff exists, ask for a target. Otherwise infer conservatively and record the scope in the final report.

Large change guidance:

- Non-mechanical changes over 800 changed lines deserve a split recommendation.
- Complex logic changes over 500 changed lines deserve review by feature/module batches.
- Split suggestions must name the smallest coherent stage that can land first.

### 2. Recover Intent

Build a short intent statement before judging the code.

Preferred sources, in order:

1. Conversation history, current user request, and explicit review focus.
2. PR title/body, linked issue, Linear ticket, plan, PRD, or spec.
3. Commit messages and branch name.
4. Tests added or changed.
5. The diff itself, only as a last resort.

Then identify what must be true for the change to be good:

- Promised requirements or acceptance criteria.
- Non-goals and scope limits.
- Compatibility, migration, rollout, or deployment constraints.
- User-visible behavior and external contracts.

If no reliable intent exists, do not invent certainty. Write "intent inferred from diff/commits" and treat mismatches, hidden scope, and unexplained behavior as review risks.

### 3. Read Local Rules And Surrounding Code

Before forming findings, inspect local guidance:

- `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `.cursor/rules`, package READMEs.
- `CONTEXT.md`, `docs/adr/`, `docs/plans/`, `docs/prds/`, `docs/specs/`, issue or PRD links.
- Existing tests, generated files, schemas, API contracts, route definitions, and package boundaries near the change.

For each changed area, gather surrounding evidence:

- Search for same concept, same route/action/hook/service/repository/component, and similar tests.
- Read callers and downstream consumers, not just the changed file.
- Compare naming, layering, state ownership, error handling, and abstraction shape with nearby code.
- Use `git log -- <file>` and `git blame -L` when history explains why code is shaped a certain way.

Use deterministic doc discovery first: for each changed file, check each parent folder for `AGENTS.md`, `CLAUDE.md`, `PLAN.md`, `TODO.md`, and `README.md`. For example, a change under `apps/frontend/pages/` should consider docs in `apps/frontend/` and `apps/frontend/pages/`, plus root-level instructions. If the doc set is large, conflicting, or intent remains unclear, use the context-librarian lane in `references/subagent-prompts.md` to rank and summarize the relevant docs before review lanes judge the code.

### 4. Run Review Lanes

Use these always-on lanes. When delegation is available, SPAWN ONE SUBAGENT PER LANE and launch every `task` call in one assistant turn so the independent lanes can run in **parallel**. Otherwise run the same lanes sequentially, keeping their notes separated before synthesis.

- `intent-contract` - verifies diff against conversation, PR body, issue, plan/PRD/spec, and external contracts.
- `standards-architecture` - checks local docs, surrounding patterns, layer ownership, naming, and backend/frontend architecture.
- `code-path-bug-hunter` - walks each changed function/class/route/consumer for runtime bugs, races, retry/idempotency failures, side-effect durability, and bad state/error transitions.
- `correctness-risk-testing` - checks logic, security, data integrity, error paths, concurrency, compatibility, and test quality.
- `documentation-commentary` - checks applicable Markdown/docs-site updates and whether changed code explains its non-obvious contracts, choices, and workarounds.
- `maintainability-elegance` - checks code judo, unnecessary complexity, over-engineering, weird branching, file growth, and refactor paths.

Add `state-transition-checker` when changed code transitions durable state or gates an external side effect. Add other conditional lanes only when the diff warrants them: security, performance, API contract, data migration, accessibility, deployment/rollback, or prior review comments.

Subagents are read-only reviewers. They may use non-mutating git/gh/rg/read commands. They must not edit files, change branches, commit, push, or post comments.

### 5. Synthesize Findings

Merge the lanes into one review:

- Deduplicate by file, nearby line, and issue.
- Keep the highest justified flag when reviewers disagree.
- Escalate the flag when independent lanes found the same issue and the impact warrants it.
- Drop weak findings that are not grounded in code, docs, tests, or stated intent.
- Separate pre-existing issues unless the diff exposes or worsens them.
- Preserve residual risks and testing gaps even when they are not primary findings.

Run a verification pass before reporting serious findings:

- For `critical` and `high`, re-check the cited code, caller path, guard, docs rule, or test gap directly.
- For judgment-heavy findings, ask a validator subagent when available.
- If you cannot verify the mechanism, downgrade to a question, residual risk, or omit it.

## Finding Bar

Report a finding when all are true:

- The issue is introduced, exposed, or materially worsened by this change.
- The mechanism is specific and evidence-backed.
- It can affect correctness, security, contracts, tests, maintainability, architecture, operability, or reviewability.
- The fix or decision path is concrete enough for the author to act on.

Suppress:

- Formatting/import/style nits owned by tools.
- Personal preference without a local rule or concrete failure mode.
- Speculative future-work concerns without current signal.
- Generic "consider adding tests" unless a real behavior, edge case, or contract is untested.
- Refactor suggestions that only move complexity around.
- Pre-existing unrelated issues.

Advisory refactor paths are allowed when they are grounded in the surrounding code and would materially reduce complexity. Label them clearly as advisory unless the current PR creates a maintainability regression.

## Review Flags

- `critical` - must fix: exploitable vulnerability, data loss/corruption, complete outage, irreversible migration breakage, or a change that cannot safely land.
- `high` - should fix: likely user-facing bug, broken contract, authz/authn gap, serious regression, unsafe rollout, or major architecture mismatch.
- `low` - worth addressing: meaningful edge case, missing coverage for changed behavior, maintainability trap, performance risk, or pattern mismatch with real downside.
- `question` - needs human clarification: missing intent, unclear product decision, conflicting docs, unverifiable assumption, or a review blocker that is not yet a proven bug.
- `hint` - optional suggestion or hunch: naming, readability, small refactor path, or suspicious shape that is not important enough to block or strongly steer the PR.

Missing or ambiguous intent is usually `question` when the change is non-obvious and reviewability is harmed. Escalate to `low` or higher only when the missing intent hides a concrete contract, data, auth, or rollout risk.

## Final Report

Load `references/output.md` before writing the final response.

Lead with findings, ordered by flag. Every primary finding needs:

- Review flag and short title.
- File path and line number.
- Evidence from the diff plus surrounding code/docs/intent.
- Impact/mechanism.
- Concrete fix, refactor path, or decision needed.

If there are no findings, say that directly and list reviewed scope plus residual risks/test gaps. Do not fill the report with praise to compensate for a clean review.
