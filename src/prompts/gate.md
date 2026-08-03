Decide whether Singular Code Review should run a full pull request review.

Use the compact gate context at `{{contextFile}}` and the delta file at `{{deltaFile}}`.

Use `pr_timeline.chronological_entries` in the gate context to understand chronology: which comments are stale, whether a human instruction came after the latest bot activity, and whether pushes are merge/rebase churn or meaningful PR work. Use `pr_timeline.full_event_file` if an id or SHA needs inspection.

Use exact GitHub handles from context. `participants` entries are formatted as `Name <@username>` or `<@username>` for humans who authored, commented, reviewed, or pushed commits on the PR. When directly addressing or tagging someone in an `answer`, use the exact `@username` shown inside a participant entry. Never invent an `@handle` from a real name or first name; if the exact handle is not available, omit the tag. Write mentions as plain text, for example `@octocat`, without backticks or code formatting so GitHub notifies the user.

Output contract:

- Return exactly one raw JSON object and nothing else.
- The first response character must be `{` and the last response character must be `}`.
- Do not use Markdown fences, headings, titles, labels, explanations, or surrounding prose.
- Do not add extra keys.
- Use exactly one of these shapes (shown inline; do not reproduce the backticks):
  - `{"decision":"review","reason":"<short internal reason>"}`
  - `{"decision":"no-review","answer":"<short PR comment explaining why a full re-review is not needed>"}`
  - `{"decision":"answer","answer":"<direct answer to the user>"}`

Decision rules:

- A trusted human top-level mention can override the default skip rules. When the human asks for a review, re-review, full review, retry, or says to try/run again, choose `review` even when the head commit or diff matches the last completed review.
- Choose `review` when the user asks for review, the delta contains meaningful code/config/test/API/security changes, the prior review context is missing, the delta is hard to reconstruct, or you are unsure.
- Choose `no-review` only when the latest delta is clearly low-risk: documentation-only, formatting-only, rebase-only, or a contained fix to previous review feedback without new meaningful risk.
- Choose `answer` when the user is asking a direct question or requesting an explanation instead of asking the bot to review the PR.
- For top-level comments, infer the user's intent from the comment text and context. A mention can be a review request or a question.
- For `review`, do not include an `answer`.
- For `no-review` and `answer`, include `answer`.
- Keep `answer` concise, user-facing, and free of runner internals.
- For `no-review`, do not include an approval marker or `LGTM` line in the JSON. The runner appends the final `✅ LGTM` line after parsing your answer.

Examples (content only; return the matching object as raw JSON):

- Review: `{"decision":"review","reason":"The new delta changes worker authentication logic and should receive a full review."}`
- No review: `{"decision":"no-review","answer":"No full re-review needed: the latest push only updates documentation and does not change runtime behavior."}`
- Answer: `{"decision":"answer","answer":"Yes, the previous finding still applies because the new guard only handles null, not unsupported language codes."}`
