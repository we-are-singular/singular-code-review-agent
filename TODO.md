# AML Reviewer Cleanup

Goal: finish the AML reviewer as the only production implementation, preserve the reusable-workflow contract, remove obsolete runtime and eval surface, and leave a small reviewed repository without pushing.

## Completed

- [x] Promote the AML review engine into the canonical `src/` tree and remove the legacy implementation.
- [x] Keep the complete AML flow visible in `src/review.tsx` with lanes and phases under `src/components/`.
- [x] Build one deterministic cached snapshot and keep Agent-facing GitHub reads focused on explicitly linked PRs, issues, and commits.
- [x] Rename the request-scoped findings owner to `ReviewQueue` and move it out of `services/`.
- [x] Remove the generic `review/types.ts` bag and colocate contracts with the modules that own them.
- [x] Move commands, telemetry, results, provider wiring, skills, lanes, phases, and deterministic review logic under explicit owners.
- [x] Move real-PR checkout orchestration to `eval/` and remove `review_dry_run` from the production package and image.
- [x] Let `actions/checkout` select the exact pull-request head and expose linked PR, issue, comment, and commit context through focused read-only GitHub Tools.
- [x] Verify the local checkout SHA against the GitHub snapshot before starting any Agent.
- [x] Install pinned backend and frontend architecture skills for OpenCode in the derived reviewer image.
- [x] Preserve `REVIEW_MODEL` and legacy `OPENCODE_MODEL` repository-variable overrides.
- [x] Enforce `proseWrap: "never"` so Markdown paragraphs remain on one source line.

## Remaining

- [x] Pin the published `wearesingular/aml-agent-sandbox:0.3.3` production base by its immutable digest.
- [x] Build and smoke the reviewer against the published AML Sandbox 0.3.3 image.
- [x] Pass TypeScript, Oxlint, formatting, shell syntax, tests, and Git diff checks after documentation settles.
- [x] Run the singular-code-review pass against the complete branch diff and fix verified findings.
- [x] Confirm no obsolete production imports, binaries, paths, or documentation remain.
- [x] Do not push.

## Historical calibration

- Fixed private ten, OpenCode/DeepSeek: 86.1/100, 193-second mean internal review time.
- Same revisions, historical source reviewer: 84.7/100, 210-second mean internal review time; directional because the model namespace differed.
- Blind public-library ten: 85.0/100, 164-second mean internal review time.
- Codex/Luna five: 83.0/100 and materially slower; evaluation-only.

These values describe pre-consolidation calibration snapshots. New benchmark captures must record the exact image, model, provider, PR revisions, and completion evidence before comparison.
