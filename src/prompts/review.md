Review this pull request using the compact reviewer context at {{contextFile}} and filtered diff at {{diffFile}}.

Use the attached context and diff as the starting point. The reviewer agent instructions own the review workflow, queueing rules, and inline-comment style; this prompt only names phase inputs and PR-history hints. Run `review_context` if you need to re-read the normalized JSON. Use read-only git, gh, rg, tests, and Context7 MCP as needed for investigation.

Path handling:

- Treat changed-file paths as repository-relative. Use `apps/web/src/file.ts`, not `/apps/web/src/file.ts`.
- A leading slash means filesystem root to OpenCode and can turn a normal repo file into an external-directory request.
- Runtime artifact paths provided by this prompt or `review_context` may be absolute; use those exact paths when reading artifacts.
- If a read, glob, or grep request is denied because a repo path was accidentally treated as external, retry the same inspection without the leading slash, try to find the file in the repo, and continue the review. Do not request broader permissions, do not edit repository files, and do not mention the denial unless it still prevents inspection after retrying repo-relative access.

For actionable findings, queue the inline comment before relying on it in terminal output. For line targeting, use `review_context`, `diff.ranges`, and `valid_comment_ranges` as the source of truth; never use artifact line numbers from `pr.diff`, `rg -n pr.diff`, or editor output.

Do not queue a final conclusion; a later audit/synthesis pass will tighten queued comments and turn your review output into the GitHub review body. Never use `gh api` to post review comments or reviews directly. Do not edit repository files.

The attached diff intentionally omits high-noise `package-lock.json` hunks. If dependency lockfile changes are materially relevant, inspect them directly with read-only git commands.

Use `pr_timeline.chronological_entries` as the compact chronological PR history. If an event SHA, review id, comment id, or thread id looks important, inspect `pr_timeline.full_event_file` or use read-only `gh`/git commands to drill down.

For re-reviews, use `pr_timeline.chronological_entries`, `recent_reviews`, `previous_bot_findings`, and `unresolved_bot_threads` as PR history. You can build on prior review findings and focus deeper investigation on the latest delta, unresolved paths, and new risk. Do not re-derive unchanged code that was already reviewed unless the new delta, an unresolved finding, or a human instruction makes it relevant again.

For re-reviews, keep terminal output delta-focused. Do not repeat a full PR summary unless the latest delta substantially changes the PR shape. Prefer a short note that says what changed since the last bot review, whether previous findings are resolved, and what remains new or risky.
