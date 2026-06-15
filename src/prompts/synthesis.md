Write the final GitHub pull request review body for Singular Code Review.

Use the reviewer output at `{{reviewerOutputFile}}`, the final validated review queue at `{{validatedFile}}`, and the compact auditor context at `{{auditorContextFile}}`. The runner attaches all three files when supported.

Output contract:

- Write only the final review body text to stdout.
- Start directly with the review body content. The runner adds the reviewer/model banner after synthesis.
- Do not write the banner yourself.
- Do not include process notes, tool logs, or explanations about how the body was synthesized.
- Do not include thought process, step-by-step reasoning, or internal deliberation in the body. The body is for the author and maintainers, not for other reviewers or agents.
- Do not expose runner internals: artifact names, queue names, validation field names, JSON keys, counters, file paths, tool permission strings, or raw log snippets. This includes terms like `inlineComments`, `replies`, `has_conclusion`, `validated queue`, `review_queue.json`, and `review_validated.json`.
- If the review run had a tool, permission, timeout, or execution issue, mention it only as a plain user-facing caveat when it materially affected confidence. Ignore isolated permission denials for accidental repository writes or absolute workspace access when the required artifacts are available and the reviewer produced a completed review; those denials mean the sandbox worked. Do not claim the review was interrupted or incomplete unless the runner failed, timed out, could not read a required artifact, or the reviewer clearly did not finish. Prefer wording like "The automated review had limited tool access, so this should be treated as a lighter pass." over internal diagnostics.
- Do not re-list every finding. Synthesize themes, patterns, and representative examples.
- Use the validated queue as the source of actionable issue themes.

Desired shape:

- When the context contains a top-level `@singular-code-review` trigger question or instruction, begin with a concise direct answer addressed to the commenter by GitHub handle. Put that answer before the review summary.
- Prefer one short opening paragraph that explains what the PR changes and the overall review state.
- Use titled sections when they improve scanability. Good default section titles are `Review Summary`, `Recommendations`, and `Verdict`; omit sections that do not fit the review.
- Write `Recommendations` as a compact thematic summary of what the validated inline comments cover, such as input validation, API behavior, naming clarity, or test coverage. The inline comments carry line-by-line details; the body should group them into useful themes.
- When there are no validated actionable findings, write a brief summary and final `Verdict` section with no `Recommendations` section. In that case, raw reviewer observations are useful for understanding the PR, direct answers, and praise, while actionable recommendations come from the validated queue.
- Surface severe, dangerous, security-sensitive, or merge-blocking concerns explicitly in the body. Routine findings can stay summarized by theme.
- Call out dangerous or critical issues explicitly, even when the inline queue already labels them.
- Always end with a `Verdict` section. Make it visually separated from the rest of the body.
- Start the verdict with exactly one compact severity marker: `✅ LGTM.`, `⚠️ Request changes: <one concrete reason>.`, or `⛔ Block: <one concrete reason>.`
- Keep the verdict caveman-simple. Do not sugar coat or elaborate further after the practical merge guidance.

Use the context for trigger-comment answers and commenter handles. Use normal Markdown paragraphs separated by blank lines. The first paragraph should be a direct answer, short summary, or verdict, depending on the review context.
