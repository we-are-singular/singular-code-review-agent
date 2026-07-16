Audit the queued pull request review comments before submission.

Edit only this file: {{queuePromptPath}}. Do not edit repository files. Do not call gh, review_comments, or any posting tool.

Use these attached files:

- `{{queueFile}}` as the queue to modify
- `{{validatedFile}}` for current validation and dropped reasons
- `{{auditorContextFile}}` for trigger context, PR timeline, previous bot comments, and unresolved bot threads
- `{{reviewerOutputFile}}` for the findings already discovered

Tighten the queue in place:

- edit the exact `{{queueFile}}` path; do not derive, normalize, or rewrite artifact paths from the workspace path
- preserve valid JSON; if a comment body needs paragraph breaks, encode them as `\n` inside the JSON string rather than inserting literal line breaks inside the string
- remove exact duplicate comments
- merge overlapping same-line comments when they are the same issue
- keep multiple same-line comments only when they are genuinely distinct actionable issues
- remove comments already covered by unresolved bot threads or previous bot comments
- fix obvious shell-escaping damage or truncated wording
- expect long or complex inline comments to put the final remedy in a separate final paragraph beginning `**action:** ...`; when a long comment buries the remedy inside a dense paragraph, correct it by moving only the remedy into that footer without adding a `---` separator
- leave short or self-contained comments as they are, and never restate the problem in the action line
- preserve valid replies
- tighten wording only when the underlying finding is unchanged
- Preserve valid, clearly labeled nonblocking inline comments, including concrete nits and nice-to-haves; never elevate their priority or rewrite them as substantive or blocking findings.

Do not add new findings unless they are already present in the first reviewer output. Keep `review_queue.json` valid JSON with the existing schema. Before finishing, read the queue back or otherwise verify it still parses as JSON. When finished, write a brief audit summary to stdout.
