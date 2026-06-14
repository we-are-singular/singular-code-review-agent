Review this pull request using the normalized context at {{contextFile}} and diff at {{diffFile}}.

Start by running `review_context` if you need the context JSON. Use read-only git, gh, rg, tests, and Context7 MCP as needed for investigation.

When a top-level `@singular-code-review` trigger comment asks a direct question or gives instructions, begin your terminal output with a concise answer addressed to the commenter, then continue with the review.

Check `unresolved_bot_threads` and `previous_bot_findings` before adding inline comments so active bot findings are handled as existing review context.

The review queue is the canonical home for actionable findings: run `review_comments add` for inline findings, `review_comments add --start-line` for multiline findings, `review_comments suggest` for code suggestions, and `review_comments reply` for existing review discussions. Use `--side RIGHT` for added lines and `--side LEFT` for deleted lines; RIGHT is the default. The `review_comments` command is installed on PATH; if you need to verify it, run `command -v review_comments`.

Only queue comments on changed source lines: RIGHT-side added lines or LEFT-side deleted lines. Before queuing, verify the target source line against `valid_comment_ranges` in the context JSON. Do not use `rg -n`, editor output, or line numbers from `pr.diff` itself as source line numbers; those are artifact line numbers, not file line numbers. If `review_comments add` rejects a target, correct the path/line/side before mentioning the finding as queued.

Use terminal output for the high-level review summary, important risk themes, praise, direct answers, and verdict. If an observation is actionable enough to be a finding, queue it before relying on it in the summary.

If multiple comments are queued for the same path and line, combine overlapping comments when they describe the same issue and keep separate comments only when they are genuinely distinct actionable issues.

Always pass review text with `--body-stdin`, `--body-file`, `--message-stdin`, or `--message-file`; prefer a single-quoted heredoc such as `<<'REVIEW_COMMENT'`. Never put Markdown, backticks, quotes, or code snippets directly in shell arguments.

Do not queue a final conclusion; a later audit/synthesis pass will tighten queued comments and turn your review output into the GitHub review body. Never use `gh api` to post review comments or reviews directly. Do not edit repository files.
