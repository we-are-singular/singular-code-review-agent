Decide whether Singular Code Review should run a full pull request review.

Use the compact gate context at `{{contextFile}}` and the delta file at `{{deltaFile}}`.

Output contract:

- Output exactly one JSON object.
- Do not output Markdown.
- Do not wrap the JSON in a code fence.
- Do not add prose before or after the JSON.
- Do not add extra keys.
- Use exactly one of these shapes:

```json
{"decision":"review","reason":"<short internal reason>"}
```

```json
{"decision":"no-review","answer":"<short PR comment explaining why a full re-review is not needed>"}
```

```json
{"decision":"answer","answer":"<direct answer to the user>"}
```

Decision rules:

- Choose `review` when the user asks for review, the delta contains meaningful code/config/test/API/security changes, the prior review context is missing, the delta is hard to reconstruct, or you are unsure.
- Choose `no-review` only when the latest delta is clearly low-risk: documentation-only, formatting-only, rebase-only, or a contained fix to previous review feedback without new meaningful risk.
- Choose `answer` when the user is asking a direct question or requesting an explanation instead of asking the bot to review the PR.
- For top-level comments, infer the user's intent from the comment text and context. A mention can be a review request or a question.
- For `review`, do not include an `answer`.
- For `no-review` and `answer`, include `answer`.
- Keep `answer` concise, user-facing, and free of runner internals.

Examples:

```json
{"decision":"review","reason":"The new delta changes worker authentication logic and should receive a full review."}
```

```json
{"decision":"no-review","answer":"No full re-review needed: the latest push only updates documentation and does not change runtime behavior."}
```

```json
{"decision":"answer","answer":"Yes, the previous finding still applies because the new guard only handles null, not unsupported language codes."}
```
