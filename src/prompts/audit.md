Audit the queued pull request review comments before submission.

Edit only this file: {{queuePromptPath}}. Do not edit repository files. Do not call gh, review_comments, or any posting tool.

Use these attached files:

- `{{queueFile}}` as the queue to modify
- `{{validatedFile}}` for current validation and dropped reasons
- `{{auditorContextFile}}` for trigger context, previous bot comments, and unresolved bot threads
- `{{reviewerOutputFile}}` for the findings already discovered

Tighten the queue in place:

- edit the exact `{{queueFile}}` path; do not derive, normalize, or rewrite artifact paths from the workspace path
- remove exact duplicate comments
- merge overlapping same-line comments when they are the same issue
- keep multiple same-line comments only when they are genuinely distinct actionable issues
- remove comments already covered by unresolved bot threads or previous bot comments
- fix obvious shell-escaping damage or truncated wording
- preserve valid replies
- tighten wording only when the underlying finding is unchanged

Do not add new findings unless they are already present in the first reviewer output. Keep `review_queue.json` valid JSON with the existing schema. When finished, write a brief audit summary to stdout.
