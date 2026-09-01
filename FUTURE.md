# Future Work

This backlog starts after the AML reviewer replacement. Changes should improve signal, latency, reliability, or managed-service operability without obscuring the declarative review tree.

## Managed service

Build the control plane that turns the current image and reusable workflow into a subscription product:

- GitHub App installation and repository selection;
- organization, subscription, plan, and usage ownership;
- repository options for model, dependency installation, paths, and triggers;
- encrypted credentials and short-lived execution grants;
- durable jobs, leases, cancellation, concurrency, retries, and billing;
- trace/result retention with repository-aware access control;
- staged image rollout, rollback, and per-run version identity.

Keep repository code and model credentials inside isolated workers. The control plane should schedule and observe work, not become a second review engine.

## Very large pull requests

Current lanes can inspect a large diff, but one monolithic context file becomes less efficient as the changed surface grows. Evaluate an AML-native partition that preserves the visible tree:

- deterministic file classification and changed-surface summaries;
- compact omission records for binary, generated, vendor, lock, snapshot, and oversized data files;
- parallel file-group investigation only above an evidence-backed threshold;
- one shared findings owner and the existing audit/validation/synthesis path;
- explicit author-facing coverage caveats when material input is omitted.

Avoid fixed comment targets or a maze of size profiles. Any partition must improve repeated scores and latency on the same large-PR corpus.

## Code-aware read Tools

Measure whether narrow read-only Tools reduce search tokens or improve findings:

- symbol outline and definition lookup;
- callers and import edges for changed public APIs;
- likely tests for a changed path or symbol;
- nearby repository guidance and ownership;
- changed route, schema, export, or package surface.

Tools should return compact evidence with paths and lines. They must not replace ordinary file reading when the model needs exact code.

## Review-thread triggers

The engine can stage replies and recognize outstanding thread work, but the example workflow does not listen to pull_request_review_comment. Add this only with a complete trust and routing design:

- bind the comment to the exact repository and PR;
- reject fork, bot, and untrusted authors before credentials;
- distinguish a direct thread response from a full re-review request;
- coalesce concurrent comments without losing a requested answer.

## Precision and observability

- Add an explicit trace signal for Context7 calls so benchmark reports can distinguish availability from actual use without scraping model text.
- Repeat selected public PRs two or three times to measure provider variance, not only single-run score.
- Expand judge questions around factual precision, duplicate mechanisms, verdict calibration, recommendation usefulness, and author effort.
- Keep historical source-versus-AML data readable, but run all new captures through the canonical production reviewer.

## Provider support

OpenCode remains the production provider. Revisit Pi only after its ACP path can match OpenCode's Tool reliability and practical latency on the same fixed PR set. Provider adoption must not add provider details to lane or phase components.
