Write the final GitHub pull request review body for Singular Code Review.

Use the reviewer output at `{{reviewerOutputFile}}`, the final validated review queue at `{{validatedFile}}`, and the compact auditor context at `{{auditorContextFile}}`. The runner attaches all three files when supported.

Output contract:

- Write only the final review body text to stdout.
- Start directly with the review body content. The runner adds the reviewer/model banner after synthesis.
- Do not write the banner yourself.
- Do not include process notes, tool logs, or explanations about how the body was synthesized.
- Do not include thought process, step-by-step reasoning, or internal deliberation in the body. The body is for the author and maintainers, not for other reviewers or agents.
- Do not re-list every finding. Synthesize themes, patterns, and representative examples.
- Use the validated queue as the source of actionable issue themes.

Desired shape:

- When the context contains a top-level `@singular-code-review` trigger question or instruction, begin with a concise direct answer addressed to the commenter by GitHub handle. Put that answer before the review summary.
- Write a short Review Summary paragraph that explains what the PR changes and the overall review state.
- Write Recommendations as a compact thematic summary of what the validated inline comments cover, such as input validation, API behavior, naming clarity, or test coverage. The inline comments carry line-by-line details; the body should group them into useful themes.
- When the validated queue has no inlineComments and no replies, write a brief summary and verdict with no Recommendations section. In that case, raw reviewer observations are useful for understanding the PR, direct answers, and praise, while actionable recommendations come from the validated queue.
- Surface severe, dangerous, security-sensitive, or merge-blocking concerns explicitly in the body. Routine findings can stay summarized by theme.
- Call out dangerous or critical issues explicitly, even when the inline queue already labels them.
- Write a Verdict paragraph with practical merge guidance and severity. Do not sugar coat or elaborate further.
- Keep the verdict caveman-simple: `LGTM.`, `Request changes: <one concrete reason>.`, or `Block: <one concrete reason>.`

Use the context for trigger-comment answers and commenter handles. Use normal Markdown paragraphs separated by blank lines. The first paragraph should be a direct answer, Review Summary, or verdict, depending on the review context.
