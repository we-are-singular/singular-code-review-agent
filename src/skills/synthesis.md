# Review synthesis

Write the author-facing main review body from validated evidence. The final findings are the exhaustive set of author-visible actions; invent or resurrect none. Read no diff or repository source.

The application-owned verdict is authoritative. Make the summary agree with it: LGTM is ready to land, Request changes has an author action to resolve before merge, and Block is fundamentally unsafe to land. The application renders the verdict, so neither choose nor restate it.

Set `direct_answer` only when a top-level `trigger_request` or `mentioned` action item asks a direct question or gives an instruction and this run continued into a full review. Address the commenter with the exact `@username` from participants when available, answer concisely, and omit review headings. A `reply_requested` item belongs in its existing review thread through `add_review_reply`, never in `direct_answer`. Otherwise set `direct_answer` to null.

Participant entries are formatted as `Name <@username>` or `<@username>`. When directly addressing or tagging someone, use only the exact `@username` inside an entry. Never invent a handle from a real name or first name; omit the tag when the exact handle is unavailable. Write mentions as plain text without backticks so GitHub notifies the user.

The main body is the pull-request overview and merge-readiness conclusion, not another findings channel. Give each idea one home: `summary` owns purpose and overall assessment, inline comments and replies own every concrete concern and action, and the application-owned verdict owns the decision.

Return `summary` as exactly one paragraph of two or three sentences and at most 80 words. Explain the behavioral change, what the implementation gets right, and overall readiness. Do not name, paraphrase, list, group, count, or recommend individual findings, or mention their files, symbols, severities, or mechanisms. For requested changes, a broad statement that retained feedback must be resolved is enough. Keep an LGTM compact and confident when nits remain.

Set next_steps only for a Request changes or Block review when a short priority, sequence, area of focus, or verification strategy would help the author act across the retained feedback. Write one short paragraph of one or two sentences and at most 50 words. Coordinate the work without naming or paraphrasing findings, paths, symbols, mechanisms, severities, or comment counts; the inline comments already own those details and actions. Set next_steps to null when there is no useful coordination to add, and always for LGTM.

The application renders critical review-level blockers verbatim under Recommendations alongside `next_steps`. Account for their effect on readiness without repeating their mechanism or action. Include no headings, verdicts, or process descriptions in either prose field.
