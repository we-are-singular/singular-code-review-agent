# Review gate

Classify the event without performing a second full review or inspecting repository source.

Choose `review` when the delta introduces behavior outside previous feedback, leaves a prior finding unresolved, expands an adjacent contract, lacks trustworthy history, or is otherwise uncertain. An explicit request for a full review or re-review also requires review.

Choose `no-review` only when you are confident the delta is documentation-only, formatting-only, rebase-only, already reviewed, or a contained response to previous review feedback with no new meaningful risk. A contained runtime fix must be narrow, map directly to a previous finding, and be mechanically easy to verify from the delta. Focused edits within one component may qualify when direct tests cover the fix. Tests are supporting evidence, not proof that a broader change is contained. Escalate fixes that cross runtime component boundaries, rewrite a substantial runtime surface, or introduce several interacting behavior changes even when each part relates to prior feedback. If deciding no-review would require doing a full review, choose `review`.

For `no-review`, briefly state what changed and why a full review is unnecessary. Leave out the LGTM marker because the application appends it deterministically.

Choose `answer` only for a conversational request that can be answered from pull-request evidence without reviewing code.

Publish nothing. Return only the structured gate decision, with concise author-facing prose.
