# AML Review Agent TODO

Goal: add a side-by-side AML implementation of Singular Code Review under
`aml/`, preserve the existing `src/` implementation, and compare both agents
with the same eval inputs and low-cost models. The v42 capture on AML 0.7.1 and
Sandbox 0.3.1 completed 10/10 after fixing a reviewer-layer Tool schema that
OpenCode could not advertise. Nine accepted judgments average 85.0%; #1081's
judge failed twice and remains explicitly unjudged. Coverage is restored, but
27 retained comments, mechanically strict low-severity verdicts, and one
21m40s provider tail show that precision and latency still need work. The 90+
quality target remains unmet as a repeatable average. The complete v40 state
is preserved in the user-requested local WIP commit; this declarative pass is
uncommitted, and nothing will be pushed.

## Discovery

- [x] Confirm the worktree is clean and record the current source/eval baseline.
- [x] Map the existing review phases, capabilities, artifacts, retries, and
      publication contract.
- [x] Verify current AML APIs and provider behavior against the official docs,
      local examples, and published package.
- [x] Choose OpenCode as the production AML provider and document the Codex ACP
      evaluation path separately.

## AML implementation

### Declarative architecture pass

- [x] Materialize `pr.md`, `pr.diff`, and `history.md` beneath the checkout's
      `.singular-code-review/` directory. Dry runs keep that checkout under the
      established `/tmp/.singular-code-review/` permission root; findings and
      phase state remain in memory.
- [x] Flatten the request Context so components consume the cached snapshot,
      GitHub boundaries, review findings, and selected model directly. Keep
      cancellation at the outer AML evaluation boundary.
- [x] Replace the custom lane scheduler, quorum, timing capture, and
      documentation-only detector with native `<Parallel>`, lane-owned review
      Tools, and compact natural-language completion handoffs.
- [x] Rename candidate plumbing around the actual review domain and make every
      Tool factory use one consistent declaration shape.
- [x] Reduce audit to one structured calibration pass with one hard finding
      cap; remove application retries, regex filtering, ranking, and fallback
      evidence selection.
- [x] Preserve typed finding metadata through deterministic validation and
      replace synthesis repair logic with a small result contract plus a
      deterministic Markdown/verdict renderer.
- [x] Move stale-head protection and deterministic GitHub Tool invocation into
      one visible in-tree publication phase; retain ambiguous-write no-replay
      behavior.
- [x] Colocate boundary schemas with their owners, remove duplicated phase
      types, and rewrite comments around actual invariants rather than obvious
      control flow.
- [x] Update architecture documentation and focused behavior tests, then run
      the complete test, lint, format, and diff validation suite.

### Interaction and critical-blocker pass

- [x] Split inline comments/suggestions from existing-thread replies at the
      Agent Tool boundary while retaining one in-memory findings owner and one
      audit/validation/publication pipeline.
- [x] Add an application-fixed, high-confidence critical blocker Tool for the
      exceptional issue that cannot honestly target one changed line. Audit may
      retain or drop it; it contributes to the deterministic verdict alongside
      every retained inline/reply finding and never replaces the review body.
- [x] Give every specialist Context7 through `ReviewLane`. Keep audit free of
      GitHub and Context7 Tools because it curates staged findings rather than
      investigating the pull request again.
- [x] Restore source-style direct answers for top-level questions that continue
      into a full review, while keeping existing-thread replies separate.
- [x] Simplify provider-factory injection to one function seam and document why
      the packaged CLI does not create a nested AML Sandbox.
- [x] Keep lane completion as the requested short unstructured return instead
      of requiring a fourth Tool call. A live smoke showed that a mandatory
      completion Tool made otherwise clean lanes fail closed.
- [x] Restrict audit to the staged queue plus optional `pr.md` and `history.md`
      consultation. It may deduplicate, group, rewrite, or recalibrate a staged
      concern, but cannot invent a target or recover a concern from lane prose.
- [x] Run the complete build, test, lint, format, and diff validation suite
      (138 tests passing).
- [x] Capture, judge, report, and inspect the fixed ten-PR OpenCode/DeepSeek
      benchmark for this architecture. V41 completed 10/10 in 5m17s mean and
      4m27s median internal time, but scored only 73% because native task
      delegation stranded every finding outside the Tool-backed queue. Keep
      the artifacts as a failure diagnosis, not a quality baseline.
- [x] Upgrade to published `@aml-jsx/sdk` 0.7.1 and Sandbox 0.3.1, remove the
      OpenCode permission workaround fixed by AML issue #36, and verify the
      released bridge with single-Agent and native-`Parallel` Tool smokes.
- [x] Diagnose the remaining zero-staging failure before launching the matrix.
      `add_review_comment` advertised a top-level discriminated-union schema,
      which OpenCode omitted from its function surface. Preserve one Tool for
      comments and suggestions by advertising a flat object envelope and
      validating the exact kind-specific contract inside `execute`.
- [x] Capture and inspect v42 on the fixed ten PRs with
      `opencode-go/deepseek-v4-flash`. It completed 10/10 with 8m07s mean and
      7m23s median internal time, 27 comments, and no Tool-unavailable lanes.
      Nine accepted judgments average 85.0%; #1081 remains unjudged after two
      bounded judge failures. The #1099 regression now survives staging,
      audit, validation, and synthesis instead of disappearing in lane prose.
- [ ] Tighten audit retention and verdict calibration without weakening the
      recovered coverage. V42 over-retained optional refactors on #1007 and
      #1068, while `low` comments described as nonblocking mechanically forced
      Request changes on #996, #1081, and other otherwise-ready reviews.
- [ ] Make the eval judge use only attached artifacts and return JSON without
      filesystem exploration. Its 120-second default was too short for three
      v42 artifacts; a bounded 300-second retry recovered two, while #1081
      still failed and must not be counted in the score.

The remaining sections preserve the chronological iteration log. Earlier
architecture descriptions are historical and are superseded by the completed
declarative pass above.

- [x] Add the AML dependency and TypeScript/JSX configuration without changing
      `src/`.
- [x] Build the declarative review workflow under `aml/` with specialist review
      lanes, audit, and synthesis.
- [x] Reuse or adapt the existing reviewer skills and deterministic review tools.
- [x] Add a CLI/runtime boundary that emits one inspectable typed result for
      the eval adapter.
- [x] Add credential-free tests for the AML tree and its result contracts.
- [x] Document local and sandboxed execution, model configuration, and security
      boundaries.
- [x] Replace the first file-oriented prototype with typed in-memory Agent
      handoffs and remove the 446-line `AmlReviewRunner`.
- [x] Declare request-scoped Tools for every GitHub read and mutation used by
      the reviewer, with separate read and publication grants.
- [x] Implement dry-run/live publication through one in-memory idempotency
      ledger; expose live writes only through `--publish` after the guard.
- [x] Limit eval-only persistence to the four final compatibility and
      observability exports.
- [x] Replace the imperative phase list with one executable nested blueprint in
      `aml/review.tsx`; keep the one explicit concurrency boundary inside the
      dedicated `ReviewLanes` component.
- [x] Split every specialist into `aml/lanes/` so adding or removing a lane is
      visible in the main tree and does not require editing an instruction map.
- [x] Isolate the specialist fan-out behind `ReviewLanes` so native `<Parallel>`
      can own scheduling without reshaping the visible workflow.
- [x] Use typed AML Context between gate, lane, audit, validation, and synthesis
      instead of serializing intermediate state or prop-drilling dependencies.
- [x] Move the canonical Markdown/JSON serializer out of the managed review
      runtime and into the eval harness; `aml_review` emits one typed result.
- [x] Make publication a deterministic AML component that invokes only Tools
      closed over the selected plan, followed by an authoritative action-ledger
      check with no mutation replay. A model cannot skip or rewrite a prepared
      GitHub side effect.
- [x] Build on the supported AML all-ACP image and use its global OpenCode
      provider contract; Codex ACP remains an explicit evaluation dependency.
- [x] Build that unreleased AML sandbox source at its pinned revision in image
      CI before the application image, so the local-only Dockerfile base does
      not leave the publish workflow unbuildable.
- [x] Grant Context7 only to the documentation lane through an explicit AML
      MCP definition; keep the other specialist capability surfaces narrow.
- [x] Re-fetch the pull-request head immediately before publication, reject
      findings prepared for a stale diff before exposing any mutation Tool,
      and bind the final review to the inspected commit through `commit_id`.
- [ ] Add a persistent publication lease before horizontally scaled managed
      workers can publish the same PR head concurrently. The in-memory ledger
      intentionally covers only one process.
- [x] Put the complete review blueprint behind an injectable, read-only AML
      `<Sandbox>` lease for the managed worker composition root. Keep the
      packaged CLI inside its existing outer reviewer container instead of
      mounting a host Docker socket or calling trusted-host `localSandbox()`.

## Evaluation

- [x] Extend the eval harness to select the existing or AML reviewer while
      keeping caches and output directories isolated.
- [x] Establish a source baseline with DeepSeek Flash v4 on `trpc/trpc#7262`
      (83/100 after the corrected verdict rubric, 4m11s capture).
- [x] Run the AML reviewer against the same `trpc/trpc#7262` revision used for
      the source baseline.
- [x] Judge and compare complete runs. The first AML-native tree scored 84/100
      with Pi/DeepSeek in 8m22s and 83/100 with OpenCode/Ox in 9m06s. After
      hardening and shortening the prompts, representative final captures
      scored 80/100 with Pi/DeepSeek in 9m10s and 79/100 with OpenCode/Ox in
      5m58s. Scores are directional model samples, not a stable benchmark.
- [x] Keep representative review latency near 7-12 minutes, targeting sub-10.
      The final Pi capture remained in that range and the final Ox capture was
      faster. This is an advisory performance target, not a review timeout.
- [x] Iterate only where eval evidence justified it: deterministic retained
      severity now corrects a synthesis verdict that conflicts with the review
      contract. The broad failed-lane retry that made an Ox capture exceed the
      old 20m safety ceiling remains removed. Two host-authenticated DeepSeek
      probes later returned only 2/6 and 4/6 structured lane results, so AML now
      retries only `aml_submit_result` failures, once, in parallel, and only
      when the first pass is below the four-lane evidence quorum. Completed
      lanes and provider/billing failures are never replayed.
      Extra questions/static analysis remain future score work.
- [x] Define a fixed-revision, history-free five-PR DAAAM basis spanning a
      two-file bug fix, medium privacy work, medium-large authorization work,
      a large cross-package feature, and a large schema migration. The real
      identifiers live only in the ignored local eval config.
- [x] Capture all five fixed PRs with the existing source reviewer and AML
      OpenCode using the same free Ox model. The first nominal source capture
      completed 5/5 at 79%, but two jobs silently used its paid MiniMax fallback
      and are retained only as mixed-model diagnostics. After the eval pinned
      all three source attempts to Ox and bumped its cache contract, source
      completed 2/5 at 88% among completed reviews in 54m12s wall time: 87% in
      10m06s and 88% in 29m29s, with three exhausted-attempt failures. The first
      AML baseline completed 4/5 at 81% among completed reviews in 36m48s; the
      broad authorization review took 21m37s because coordinator failures
      replayed its whole tree.
- [x] Re-run after phase-local audit/synthesis recovery replaced whole-tree
      replay. Final OpenCode/Ox completed the small, privacy, and authorization
      PRs in 6m05s, 6m23s, and 6m51s at 89%, 81%, and 83%. The schema migration
      hit the old two-synthesis failure at 8m12s, which is now covered by the
      deterministic synthesis fallback; the notification feature retained one
      specialist until the 30-minute stuck-process ceiling.
- [x] Judge provider behavior on the same basis. Pi/DeepSeek completed 3/5 at
      88% among completed reviews (89%, 86%, and 88%) in 6m12s, 13m31s, and
      13m55s; both failures produced only 3/6 valid lanes, below the unchanged
      four-lane evidence minimum. OpenCode/Ox completed 3/5 versus source/Ox's
      2/5. OpenCode/DeepSeek then completed 5/5 at 83% (78%, 81%, 84%, 84%,
      and 87%) in 3m20s, 6m39s, 9m49s, 6m08s, and 10m01s. That complete
      historical artifact records the older `opencode-go/deepseek-v4-flash`
      identifier; its average review took 7m11s, and the five-PR wall time was
      22m49s at concurrency two. OpenCode/DeepSeek is therefore the default.
      Pi is being removed from the application provider surface because its
      higher completed-set score is outweighed by intermittent structured-result
      loss and 3/5 completion. Scores are directional model samples; hard
      completion takes precedence over a higher partial-set average.
- [x] Preserve a larger unchanged-prompt OpenCode/DeepSeek control across ten
      fixed revisions. The final v29 run completed 10/10: AML scored 84.8/100
      and `src` scored 84.7/100 on identical revisions. AML averaged 414.2s
      uncached capture and 400.4s internal review time; `src` averaged 236.2s
      and 209.8s. The v20 AML run (79.4%) and earlier partial/contaminated
      captures remain historical diagnostics, not final benchmark evidence.
- [x] Capture the fixed five-PR comparison with AML Codex ACP using
      `gpt-5.6-luna` at `max` reasoning. It completed 5/5 and scored 83%
      average (84%, 85%, 79%, 82%, 85%). Agent time was 9m40s, 22m39s,
      23m50s, 26m25s, and 20m06s; 29/30 specialist lanes returned valid
      structured results. This confirms the combination works but is not the
      production default because its mean 20m32s review time trails OpenCode.
- [x] Define Codex authentication as the host ChatGPT Codex login. The eval
      harness stages an ephemeral writable `${CODEX_HOME:-~/.codex}/auth.json`
      copy per job, deletes it in `finally`, and never forwards API-key env
      credentials or writes auth state to artifacts/cache. The six-agent API-key
      diagnostic (4/6 after 28 reconnects, trace: `no credits`) is invalid and
      excluded from benchmark evidence.
- [x] Add an explicit eval `--base-image <tag>` override for local unreleased
      AML sandbox builds, record it in `run-config.json`, and preserve the
      Dockerfile default when the option is omitted.
- [x] Confirm the specialist fan-out is real and locate the latency. Each live
      PR showed six sibling ACP sessions and provider processes. Container,
      clone, CLI, and ACP startup added only 12-20 seconds to completed AML
      reviews; the longest specialist/model call, not sequential orchestration,
      dominated wall time.
- [x] Remove the unenforced `bootTimeoutMs` compatibility option. The outer
      Docker process emits clone/provision output before the reviewer starts,
      while an ACP may validly remain silent during reasoning; a no-output
      watchdog at that boundary would be either ineffective or destructive.
- [x] Separate uncached capture wall time from implementation-owned reviewer
      timing. Cache hits no longer masquerade as fast captures, and reports
      state that AML covers its in-memory workflow while `src/` sums model
      phases.
- [x] Remove generic fallback token prices. Subscription-backed ACP runs and
      provider models without an exact configured or reported charge now show
      `n/a` instead of fabricated API spend.
- [x] Make benchmark evidence fail closed: ordinary reports reject running
      captures, aggregation excludes partial summaries, judged completions
      outrank newer diagnostic failures, and append reuse compares history,
      label, and notes semantics as well as the PR/model identity.

## AML feedback

- [x] Investigate suspected AML behavior and seek a minimal framework
      reproduction. The final paired provider matrix confirmed intermittent Pi
      structured-result loss: failed lanes ended with
      `ACP Agent did not submit a valid result through aml_submit_result`, and
      two reviews stopped at 3/6 lanes while OpenCode completed 5/5.
- [x] File the public-safe Pi ACP limitation as AML issue #13, including the
      missing usage telemetry as a diagnostic symptom without publishing
      private pull-request identifiers or raw traces.
- [x] File AML issue #14 for the published sandbox image missing Agent ACP
      executables. Keep evaluation on the unreleased local all-ACP image until
      a published image contains the documented provider commands.
- [x] File AML issue #20 for OpenCode's native `task` subagents widening the
      parent Agent permissions and leaving non-interactive runs blocked on
      permission prompts. Mirror the review restrictions into OpenCode's
      global config until AML can enforce inherited restrictions itself.
- [x] File AML issue #22 for OpenCode's missing server-qualified
      `aml_submit_result` guidance. The provider ignores AML's random MCP
      server name while Copilot and Pi supply provider-specific structured
      output instructions, matching the observed stochastic result loss.
- [x] File AML issue #23 because `opencodeAgent({ model })` configured the
      process but never selected the advertised ACP session model, silently
      leaving live reviews on OpenCode's fallback model.
- [x] File AML issue #24 because the OpenCode provider's private
      `XDG_DATA_HOME` hid request-local login copies. Honor an explicit data
      home while retaining isolated defaults for every other Agent state path.
- [x] File AML issue #36 because the OpenCode provider's generated `aml` Agent
      wildcard overrides caller-disabled native Tools. Until that lands, deny
      `task` by permission as well as configuration and keep review fan-out in
      the authored AML `<Parallel>` tree.

## Next iteration

- [x] Remove Pi provider selection, fallback flags, and eval dimensions from
      this application. Keep one provider factory with OpenCode as production
      default and Codex ACP available only for explicit evaluation selection.
- [x] Verify OpenCode ACP reasoning-variant selection before paid evaluation.
      ACP model choices encode the variant as `provider/model/variant`; fail a
      smoke test instead of silently running a base model when `max` is absent.
- [x] Consolidate the five AML Context objects into one immutable staged
      `ReviewFlowContext`. Preserve nested phase scoping and add concurrent-run
      isolation and missing-phase tests.
- [x] Run the fixed five-PR Codex/Luna comparison. It completed 5/5 at 83%;
      approximately ten minutes remains an advisory target, not a timeout.
- [x] Run the final ten-PR OpenCode/DeepSeek comparison with the local AML
      image. v29 completed 10/10 at 84.8/100 for AML and 84.7/100 for `src`.
      AML's wall time was 69m03s at concurrency 1; approximately ten minutes
      remains an advisory review target, while the 30-minute ceiling remains a
      stuck-process safety bound rather than an expected duration.
- [x] Rebuild the reviewer on the local AML workspace at clean revision
      `160ee881` from locally packed SDK/CLI/ACP artifacts. The final image
      uses the local unreleased base and contains the permission, qualified
      Tool, ACP model-selection, and staged-login fixes.
- [x] Run the source reviewer with OpenCode/DeepSeek on the same exact ten PR
      revisions, including the fixed-five subset. The final comparable source
      result completed 10/10 at 84.7/100, with 236.2s mean uncached capture and
      209.8s mean internal review time. Earlier 85%/85.2% results used a prior
      reviewer revision and remain historical.
- [x] Prevent concurrent eval invocations from deleting each other's live
      containers. Each evaluator now owns a UUID lease with a heartbeat instead
      of the container-local PID `2`; startup reaps only expired owned
      containers and preserves both fresh and legacy unowned containers.
      Signal/exit cleanup keeps failed removals tracked for one bounded retry.
- [x] Improve the existing six lanes instead of adding another lane: tighten
      contract/consumer enumeration, reachability and observable-impact proof,
      migration/config rollout checks, and changed-line/source discipline.
- [x] Tighten audit calibration so malformed-input, disputed product-choice,
      or unverified observable-behavior claims become hints or residual risks
      instead of blocking low findings.
- [x] Make synthesis thematic and shorter: do not repeat inline titles,
      mechanisms, paths, or actions; use one short paragraph for zero or one
      retained finding and target 90-140 words.
- [x] Remove model synthesis from zero-finding reviews. The first controlled
      v9 capture invented generic praise and `pnpm` validation commands despite
      an empty validated queue; deterministic LGTM prose is faster, stable, and
      cannot introduce unsupported author actions.
- [ ] Reach the quality target in a future paired DeepSeek prompt A/B. v29
      achieved 10/10 completion and 84.8/100. Its 6m54s capture mean matches the
      roughly 7-12 minute reference, but it did not reach a repeatable 90+
      average.
- [x] Measure the first tuned DeepSeek side of that pair. It captured nine
      usable reviews in 3m09s-9m30s; the tenth exposed an eval process-timeout
      hang and was not counted. The original ambiguous judge scale scored the
      set at 79%; the clarified scale scores the same immutable captures at
      85%. This run records the current `opencode/deepseek-v4-flash` identifier;
      its fixed-five basis subset completed 5/5 at 85.8% in a 6m23s mean
      recorded duration. The harness now settles the timed-out worker and
      labels incremental `run.json` snapshots as running instead of finished.
- [x] Tune the audit boundary without adding a second findings-judge model.
      The audit transport accepts up to 24 candidates; deterministic
      post-processing ranks and focuses the final result to at most eight,
      dropping self-disqualified accepted/equivalent/unreachable/non-defect
      candidates. Final prose uses AML's natural text output with one
      deterministic fallback. Generic static analysis remains intentionally
      absent. One #1007 duplicate-subset finding remains a known residual.

## Post-v29 architecture refinement

- [x] Compare AML with the existing `src/` gather, queue, audit, validation,
      synthesis, and publication boundaries before changing the new flow.
- [x] Make acknowledgement a deterministic reaction Tool call after the cached
      history check instead of spending an Agent turn on a fixed side effect.
- [x] Give every lane request-scoped `add_review_comment`,
      `add_review_suggestion`, and `add_review_reply` Tools. Candidate writes
      stay in memory, validate their anchors immediately, and never mutate
      GitHub.
- [x] Remove the duplicated structured lane result and its follow-up turn.
      Lanes now queue actionable evidence incrementally and return only a short
      natural-language assessment for audit and synthesis context.
- [x] Keep semantic deduplication in one audit pass and deterministic
      changed-line, reply-target, history, exact-duplicate, verdict, payload,
      and publication rules in application code.
- [x] Remove regex-based review-theme inference. Synthesis now receives the
      holistic audit assessment, completed lane summaries, and the exact
      validated author-visible comments without treating residual notes as a
      second findings channel.
- [x] Restore one synthesis call for clean reviews now that compact lane
      assessments provide useful holistic context. The deterministic body
      remains the failure fallback and cannot promote residual notes.
- [x] Reduce coverage-pressure wording in the lane and audit prompts. Preserve
      the evidence bar and lane responsibilities without forcing a suggestion,
      exhaustive generic checklists, or long terminal JSON.
- [x] Add a conservative documentation-only profile that avoids starting the
      two runtime code lanes only when the complete diff proves they cannot
      apply. Ambiguous, mixed, renamed, or deleted changes run every lane.
- [x] Finish behavior tests for candidate Tool validation, idempotency,
      parallel lane collection, holistic synthesis, and the documentation-only
      fast path.
- [x] Run build, focused tests, the full 143-test suite, lint, format checking,
      and a final architecture/code-review pass.
- [x] Smoke and benchmark the revised flow with the fixed five-PR basis using
      `opencode-go/deepseek-v4-flash`. v30 completed 5/5 at an unrounded 87.8%
      average, 5m08s mean capture, 4m54s mean internal review, and 2.6 comments
      per review. The same-PR v29 subset scored 84.4% at 5m34s/5m20s and 3.0
      comments, while the earlier exact-model fixed-five run scored 82.8% at
      7m11s/6m58s and 3.4 comments. Treat the quality gain as directional until
      repeated; the v29 subset used the `opencode/` route rather than
      `opencode-go/`.
- [x] Fix the eval report to derive the publication verdict from the captured
      terminal review marker. The v30 judge praised two Request-changes reviews
      but returned `lgtm` as its quality label, which previously made the
      report mislabel the actual author-facing verdict.
- [ ] Tighten lane terminal synchronization after live outputs ignored the
      compact-handoff request in several lanes. The v32 smoke confirmed that
      OpenCode ACP concatenates intermediate `I'll`/`Let me` message chunks
      into the Agent result even when the final prompt forbids narration.
      Preserve the single natural return and Tool-authored findings; do not
      reintroduce a structured follow-up turn or discard evidence with a
      topic-specific text filter.
- [ ] Remove the remaining synthesis repetition without a finding quota or
      hardcoded themes. The #1068 and #1099 judges still saw recommendations
      echoing retained inline comments, and large reviews can still accumulate
      lower-value hints and nits.

## Re-review fast path

- [x] Reuse the source reviewer's deterministic `prepareGate` implementation
      from the AML tree. Same-head detection, commit ancestry, focused deltas,
      rebase/range-diff comparison, patch IDs, missing-history fallback, and
      explicit human re-review overrides therefore have one implementation.
- [x] Keep re-review routing ahead of the specialist tree. Confident same-head
      events exit without an Agent; other reconstructable follow-ups use one
      cheap gate Agent and start all review lanes whenever the answer is
      uncertain.
- [x] Align the AML gate with the source contained-fix contract. Narrow fixes
      that map directly to prior findings may fast-track, while cross-component
      or interacting runtime changes escalate even when they include tests and
      claim to address review feedback.
- [x] Append the final `✅ LGTM` marker deterministically for every no-review
      response instead of asking the gate Agent to reproduce publication prose.
- [x] Cover same-head, contained-fix, uncertain-delta, and explicit human
      re-review paths through the AML runtime. The tests assert provider-call
      counts, specialist fan-out, normalized publication payloads, and the
      absence of lane work on fast paths.
- [x] Replay six historical DAAAM fast-path synchronizations plus one negative
      control with `opencode-go/deepseek-v4-flash`. All seven routed correctly:
      the six safe follow-ups skipped the lane tree in a 19.5s mean and 13.5s
      median gate time, while #1193 escalated in 11.5s because its broader fix
      crossed runtime components. These are gate-only timings; an escalated
      event still pays the normal full-review cost.
- [x] Validate the finished re-review pass with the focused 16-test AML runtime
      suite, the complete 147-test repository suite, TypeScript and Oxlint,
      Oxfmt, `git diff --check`, and an independent final diff review.

## v31 score and speed confirmation

- [x] Capture the unchanged fixed five DAAAM revisions with the current AML
      worktree, `opencode-go/deepseek-v4-flash`, concurrency two, and a fresh
      image/cache namespace. The rebuilt local AML base is clean revision
      `c601c37`; v31 completed 5/5 in 17m15s wall time.
- [x] Judge all five captures with the unchanged rubric, generate the report,
      inspect the actual reviews, and compare directly with v30. V31 scored
      87.4% versus 87.8%, averaged 6m15s capture and 5m59s internal reviewer
      time versus 5m08s/4m54s, and produced 2.0 comments per review versus 2.6.
      The per-PR scores were 91, 88, 90, 83, and 85 for #1048, #1099, #1081,
      #1068, and #1064 respectively.
- [x] Inspect the review-level differences instead of treating the average as
      sufficient evidence. V31 removed two low-value #1099 comments, but #1064
      selected a different valid migration finding while missing v30's expired
      member guard issue, and #1068 exchanged the workspace-grouping bug for a
      valid delivery-abort bug while taking 4m19s longer internally. All ten
      v30/v31 captures bypassed the re-review gate, so the 0.4-point score delta
      and 22% mean latency increase are repeat-run/provider variance evidence,
      not a measured effect of the new re-review routing.
- [x] Export monotonic wall duration for every successful or not-applicable
      specialist branch without exposing telemetry to audit or synthesis. The
      next report can identify the lane that owns the critical path instead of
      inferring it from aggregate workflow time.
- [ ] Add failed-lane and audit/synthesis timing only if the next measured run
      leaves material latency unattributed. Request timing already exists;
      avoid expanding telemetry before the successful lane durations prove it
      is needed.

## Native Parallel and iterative tuning

- [x] Consolidate on the published AML SDK `0.7.0`, CLI `0.3.2`, and sandbox
      `0.3.0` release. Remove the temporary AML source checkout, package
      overlay, and local-base image path; pin the official sandbox by digest.
- [x] Replace fabricated Tool execution contexts with callable Tools inside the
      AML tree. Deterministic acknowledgement and publication now inherit AML
      cancellation, tracing, validation, and pending-work ownership.
- [x] Add content-free native trace summaries and named application spans for
      gate, lanes, audit, validation, synthesis, acknowledgement, and
      publication. Keep provider usage optional and derive it from the same
      completed evaluation summaries.
- [x] Verify AML's bounded ACP messages against live OpenCode output. The
      runtime now passes the final bounded assistant message when available,
      but DeepSeek sometimes writes a long final handoff of its own. Preserve
      that honest provider boundary instead of adding a brittle prose filter or
      another Agent turn; the audit still receives the evidence it needs.
- [x] Keep the remaining tuning pass within 20 new reviews: three repeated
      #1099 canaries, a five-PR gate, and the fixed ten, leaving two runs for a
      failed capture or narrow confirmation. Every OpenCode run must use
      `opencode-go/deepseek-v4-flash`; the `opencode/` route can fall back to
      Zen and is not valid evidence. The final ledger used exactly 20 captures:
      three repeated v38 canaries, five v39 reviews, one v40 synthesis canary,
      ten first-pass v40 reviews, and one unchanged #934 retry after its first
      provider attempt reached the 30-minute stuck-process safety ceiling.

- [x] Preserve the complete v31 implementation and public eval harness in a
      local WIP commit before changing orchestration. Generated captures,
      private PR identifiers, credentials, and caches remain ignored. The same
      local-only commit now carries the v40 keeper snapshot; it was not pushed.
- [x] Replace `ReviewLanes`' manual `Promise.allSettled()` fan-out with AML's
      native `<Parallel>` while preserving authored lane order, request-local
      candidate Tools, partial-failure reporting, and the four-lane evidence
      quorum.
- [x] Add focused native-Parallel tests before any prompt tuning. A failed lane
      must remain observable without aborting usable sibling evidence, and
      documentation-only applicability must continue to skip runtime lanes. The
      local image build, import smoke, and complete 149-test suite passed.
- [x] Inspect lane summaries, queued findings, audit decisions, synthesis, and
      phase timing on controlled smoke outputs. The same #1048 revision
      completed before and after the prompt change with all six lanes and an
      empty validated queue. Constraining only clean-review presentation
      changed the four-bullet LGTM into one three-sentence paragraph and moved
      internal review time from 2m06s to 1m55s. The lane handoff prompt did not
      stop ACP progress chunks, so that boundary remains explicitly open
      rather than adding a brittle sanitizer.
- [x] Capture and judge the first native-Parallel fixed five with a fresh cache.
      V32 completed 5/5 at 85.2%, 7m47s mean capture, 7m33s mean internal time,
      and 2.0 comments per review. It was not promoted: #1099 replaced a
      user-visible downstream behavior question with future-only nits, #1081
      and #1068 repeated inline actions in Recommendations, and #1064 hid
      useful migration residual risk from its clean LGTM body. #1068's 14m08s
      capture also pushed the mean above v30/v31 despite faster #1048/#1081
      cases.
- [x] File AML issue #28 for the provider-neutral ACP message-boundary gap.
      Stable ACP v1 concatenates progress and final assistant chunks, so the
      application cannot safely extract a terminal lane handoff without a
      brittle text heuristic.
- [x] Repeat the fixed five after the v33 downstream-behavior, speculative-nit,
      residual-risk, Recommendations, and per-lane-timing changes. V33 completed
      5/5 with OpenCode and `opencode-go/deepseek-v4-flash` at 6m11s mean capture,
      5m57s mean internal review time, and 1.6 comments per review. Four stable
      judgments averaged 87.0%; #1064's review completed with a substantive
      migration-order finding, but its judge entered repository tool calls and
      returned `judge exited null` on three attempts, so no score was invented.
      Compared with v32, v33 recovered the downstream guest-filter regression
      on #1099 and deployment-order outage on #1064 while removing future-only
      #1099 nits. Per-lane timings confirm bug-hunter/correctness agent work, not
      native Parallel or documentation, owns the long tail.
- [x] Run the v33 fixed ten as a wider calibration pass. It completed 10/10
      without review retries or timeouts at 86.5%, 7m51s mean capture, 7m36s
      mean internal time, and 2.2 comments per review. This improves v29 quality
      by 1.7 points and reduces comments from 35 to 22, but is 56s slower. The
      wider set exposed two repeatability boundaries: #1064's real old-worker /
      new-schema rollout failure did not survive a fresh sample, and #934's
      supported access-widening backfill candidate was demoted to residual risk.
      It also confirmed that bug-hunter owns the critical path in 8/10 reviews.
- [x] Test v34's narrow corrections on the fixed five: give each lane the
      already-cached filtered diff in its first turn, require schema/runtime
      overlap analysis, retain irreversible migration questions when a current
      row shape is reachable, and drop future-only ownership or micro-tuning
      comments. Promote only if coverage improves without slowing the run. The
      first exact-revision #1064/#934 canary reached the provider but produced
      no review evidence because OpenCode-Go returned `Insufficient balance`
      for every lane. This is an external billing block, not a product result,
      and must be rerun unchanged rather than counted or replaced with another
      provider/model combination. While blocked, the offline audit corrected
      both fixed corpora and all AML defaults to
      `opencode-go/deepseek-v4-flash`, added the reviewer Docker image ID to
      review-cache identity, and preserved current normative-contract findings
      while filtering future-only documentation drift. All 149 tests, lint,
      formatting, and the container CLI smoke pass; rebuilt image
      `sha256:600c80d3` is ready. Live coverage and latency remain unproven until
      the unchanged canary completes. The fresh r2 canary then completed 2/2:
      #1064 and #934 both scored 87, recovered the previously inconsistent
      rollout/access-widening findings, and finished internally in 3m59s and
      5m09s versus v33's 5m38s and 8m11s. Promote this exact image to the fixed
      five before making another prompt change. The v34 fixed five completed
      5/5 at 86.4%, 4m42s mean internal time, and 1.4 comments per review. Every
      PR was faster than v33 (21% mean improvement), but #1099 initially looked
      like it missed a guest gallery uploader/filter regression and #1081's
      clean LGTM body recapped its two optional hints. The first concern was a false alarm on
      inspection: #1099's PR body explicitly says the gallery uploader section
      hides when the roster is withheld, so v33's claim that the consequence
      was unacknowledged was wrong and v34's LGTM is calibrated.
- [x] Recheck the v36 synthesis-only correction on the fixed five. The rejected
      v35 consumer-enumeration experiment still returned the correct #1099 LGTM
      but stretched it to 9m21, so that lane wording was removed. Keep only the
      clean all-hint/nit body rule and deterministic removal of decorated
      duplicate verdict lines. V36 completed 5/5 at 88.4%, 5m39s mean internal
      time, and 1.8 comments per review. It fixed #1081's merge-conditional LGTM
      prose, kept #1099's body clean despite one valid nit, and preserved the
      substantive #1064/#1068 findings. It was slower than v34's unusually fast
      sample but remained faster than v33, so this exact image is promoted to
      the fixed ten without another prompt change.
- [x] After the five-PR gate is healthy, run the fixed ten-revision comparison
      for AML and unchanged `src/` on identical inputs, then produce the final
      quality, speed, completion, and output-shape report. Treat 7-12 minutes as
      a performance reference, never as a ten-minute timeout. The first v36 AML
      pass completed 7/10 canonical captures before OpenCode-Go returned
      `Insufficient balance` for #934, #1007, and #884. An immediate append
      correctly reused the seven completed image-pinned captures but produced
      0/3 new reviews, so this partial matrix must not be judged or compared.
      V40 subsequently completed the same ten revisions with the exact Go /
      DeepSeek model: 87.5% nominal mean, 7m04s mean and 5m50s median internal
      time, and 1.4 comments per review. The unchanged source baseline is 84.7%,
      3m30s mean internal time, and 0.6 comments per review. V40 therefore adds
      2.8 nominal score points over source while remaining about twice as slow.
      Treat 87.5% as judge output rather than clean ground truth: #1099's judge
      rewarded a false blocker that contradicted the PR body's explicit
      accepted gallery behavior.
- [x] Recheck v36 finding repeatability before declaring it final. The partial
      pass correctly reviewed #1014, but one #1099 sample contradicted the pinned
      PR body by calling an explicitly recorded gallery-filter consequence
      unmentioned, and #996 elevated an unmeasured optimization whose own action
      said "ship as-is" to Request changes. Tiptap 3.27.1's official source also
      proved the second #1099 question false: `initialItems` is normalized with
      `?? []` before the renderer receives it.
- [x] Gate the narrow v37 audit correction after OpenCode-Go balance returns.
      The audit now treats the PR body as authoritative for accepted decisions,
      has Context7 available only for disputed external contracts, requires
      actual performance evidence, and deterministically drops a finding that
      explicitly concludes the PR can ship as-is. Focused tests, the local image
      build, and the container CLI smoke pass; image
      `sha256:f713a660f32857c5fe2a3d1626bc052b02c9d012bba381ce6af4f36ce0dc91b4`
      was promoted through the three independent v38 #1099 canaries and the
      fresh v39 fixed-five gate; no v36 capture was mixed into either score.
- [x] Run the unchanged #1099 v38 canary three times with
      `opencode-go/deepseek-v4-flash`. All three completed in 4m29s, 4m19s,
      and 4m31s internal time, rejected the previous false blocker, and kept an
      LGTM verdict. Two returned no comment; one retained an accurate comment-
      wording nit. The three judgments scored 78, 83, and 87, but the lower two
      incorrectly penalized the reviewer for honoring the PR body's explicit
      gallery-filter decision. Use the raw output, not that mistaken judge
      preference, for the next calibration.
- [x] Validate the v39 audit calibration on the fixed five. Residual risks and
      testing gaps now obey the same accepted-scope bar as findings, while a
      genuinely useful hint or nit must be concrete and compact instead of a
      long optional action section.
- [x] Validate v39 on the fixed five with the exact Go/DeepSeek model. It
      completed 5/5 at 86.4%, with 4m29s mean capture, 4m16s mean internal AML
      time, and one comment per review. #1048, #1099, and #1081 were clean
      LGTMs; #1064 preserved the version-skew migration defect; #1068 retained
      four concrete email-path defects. The run is substantially faster than
      v36 but is not the final presentation state: both finding-heavy bodies
      repeated inline detail in top-level prose.
- [x] Smoke v40 on the finding-heavy #1068 revision before the fixed ten. The
      synthesis prompt now restores src's "one idea, one home" contract and
      permits only broad shared guidance above the detailed inline comments;
      it does not infer or serialize hardcoded themes. The canary completed in
      7m20s internally, retained one concrete workflow-email navigation
      regression, and reduced the top-level body to one broad regression
      sentence plus the detailed inline comment. Synthesis itself took 8s; the
      slower sample came from the architecture lane and audit. Its judge spent
      the full three-minute ceiling in a shell Tool and exited without a final
      judgment, so no score was invented and the complete review remains valid.
- [x] Run and judge the final fixed ten on this exact v40 image. The first pass
      completed and was judged for nine revisions; #934 alone required the
      reserved unchanged retry. The assembled ten-review corpus scored 87.5%
      nominally, produced 14 comments, and returned three LGTM and seven
      Request-changes verdicts. Manual review corrects #1099 to LGTM because its
      sole finding contradicts an explicit PR-body decision. Nine reviews
      completed internally in 37s-6m45s; #884 was a 25m10s provider tail.
- [x] Complete the final #934 cell with the one reserved capture. The first
      fixed-ten pass completed 9/10; #934 alone reached the unchanged 30-minute
      stuck-provider ceiling, while #884 completed after roughly 25 minutes.
      The reserve used the same revision, image, model, and timeout and
      completed in 4m45s internally with one valid low-severity finding.
- [ ] On the next review budget, correct accepted-decision salience at the audit
      boundary without hardcoding #1099's gallery topic, then repeat the same PR
      before promoting the change. Also remove duplicated top-level
      Recommendations mechanically or tighten their contract; v40 still
      repeated inline actions on #1007 and #1014 and emitted a content-free
      Recommendations section on #1068.

## Handoff

- [x] Run focused tests, full tests, lint, and formatting checks after the
      final sandbox and report changes. The final pass completed 133 tests plus
      build, TypeScript/oxlint, formatting, and `git diff --check`.
- [x] Run all Singular Code Review lanes over the final diff and fix validated
      findings. Documentation now distinguishes the AML provider default from
      the shipped workflow and records that v29 met the timing reference while
      missing the 90/100 quality target. The remaining publication preflight
      race is documented as residual risk rather than expanded in v29.
- [x] Review the final diff and report generated eval artifacts separately.
      Benchmark captures and generated HTML/JSON/Markdown reports remain under
      ignored `eval/runs/`; implementation and public methodology changes are
      visible in the working tree. `src/` has no working-tree or branch delta
      from `origin/main`.
- [x] Leave the implementation uncommitted and unpushed through the v31 review,
      then preserve it in the requested local WIP commit. That local-only
      snapshot now includes native Parallel, the published AML consolidation,
      and the v40 tuning; the branch must not be pushed.
- [x] Generate/review the final AML-versus-source benchmark report. On the same
      ten revisions, v40 AML/OpenCode-Go/DeepSeek is nominally 87.5% vs 84.7%
      for `src`/OpenCode/DeepSeek, with 7m04s vs 3m30s mean internal time and
      1.4 vs 0.6 comments per review. Historical AML v29 was 84.8% and v33 was
      86.5%; AML-only Codex ACP/Luna Max was 83.0% on the fixed five and took
      20m32s mean internal time. Preserve separate capture and internal timing,
      flag v40's confirmed #1099 false blocker, and mark earlier Pi/Ox,
      fallback-model, partial, and API-key diagnostic runs invalid or
      historical.
