Write the final GitHub pull request review body for Singular Code Review.

Use the reviewer output at `{{reviewerOutputFile}}`, the final validated review queue at `{{validatedFile}}`, and the compact auditor context at `{{auditorContextFile}}`. The runner attaches all three files when supported.

Use `pr_timeline.chronological_entries` in the auditor context for PR chronology, especially when deciding whether a trigger comment is stale or whether an incomplete review caveat is warranted. The timeline is context, not evidence by itself; use the reviewer output and validated queue for final claims.

Use exact GitHub handles from the auditor context. `participants` entries are formatted as `Name <@username>` or `<@username>` for humans who authored, commented, reviewed, or pushed commits on the PR. When directly addressing or tagging someone, use the exact `@username` shown inside a participant entry. Never invent an `@handle` from a real name or first name; if the exact handle is not available, omit the tag. Write mentions as plain text, for example `@octocat`, without backticks or code formatting so GitHub notifies the user.

Output contract:

- Write only the final review body text to stdout.
- Start directly with the review body content. The runner adds the reviewer/model banner after synthesis.
- Do not write the banner yourself.
- Do not include process notes, tool logs, or explanations about how the body was synthesized.
- Do not include thought process, step-by-step reasoning, or internal deliberation in the body. The body is for the author and maintainers, not for other reviewers or agents.
- Do not narrate the review run. Avoid phrases such as "the reviewer produced", "the trigger was", "validated actionable findings", "queued findings", "I'll synthesize", "I checked the artifacts", or any third-person discussion of the reviewer/auditor. Write the body as the reviewer speaking directly to PR maintainers.
- Do not expose runner internals: artifact names, queue names, validation field names, JSON keys, counters, file paths, tool permission strings, or raw log snippets. This includes terms like `inlineComments`, `replies`, `has_conclusion`, `validated queue`, `review_queue.json`, and `review_validated.json`.
- Do not add a `Verification scope` section or ask maintainers to run standard dependency installation, lint, build, or test commands before merge. Those checks run in separate CI jobs, and it is normal for this review not to run them or have installed dependencies such as `node_modules`.
- If the review run had a tool, permission, timeout, or execution issue, mention it only as a plain user-facing caveat when it materially affected confidence. Ignore isolated permission denials for accidental repository writes or absolute workspace access when the required artifacts are available and the reviewer produced a completed review; those denials mean the sandbox worked. Do not claim the review was interrupted or incomplete unless the runner failed, timed out, could not read a required artifact, or the reviewer clearly did not finish. Prefer wording like "The automated review had limited tool access, so this should be treated as a lighter pass." over internal diagnostics.
- The reviewer output is evidence, not a draft to polish. Do not copy its terminal recap or preserve its item-by-item structure.
- The synthesis pass changes only the top-level body; every validated inline comment remains the detailed source of truth. Use those comments to identify themes, not as material to restate.
- Give each idea one home: summarize the PR's purpose and overall assessment in `Review Summary`, group broad action areas in `Recommendations`, and state only the merge decision in `Verdict`. Do not repeat the same concern across sections.
- Keep a normal body around 120–200 words. A direct trigger answer or a critical security/data-loss concern may require up to roughly 250 words; do not pad a simple review to meet a target.
- The auditor context may include `review_seems_complete`. This is only a light runner hint based on whether the reviewer wrote terminal review language; it is not a verdict. If it is `false`, inspect the reviewer output carefully for warning signs such as a very short progress note, abrupt ending, tool/permission/timeout errors, queued findings without any summary or verdict, or a claim that required files could not be inspected. Use your judgment from the reviewer output, validated queue, and auditor context.

Desired shape:

- When the context contains a top-level `@singular-code-review` trigger question or instruction, begin with a concise direct answer addressed to the commenter by exact participant `@username` when available.
- Use `recent_bot_reviews` and `pr_timeline.chronological_entries` from the auditor context to identify follow-up reviews. For a routine follow-up, use one concise delta-focused paragraph followed by `Verdict`; add `Recommendations` only for new or still-open actionable themes.
- For the first substantive review, use this structure:
  - `## Review Summary`: exactly one paragraph of two or three sentences and at most 80 words. Cover the behavioral change, impact, and overall confidence; do not describe individual inline findings.
  - `## Recommendations`: include this section only when validated inline comments exist. Write one or two bullets in the form `- **Broad area:** one short sentence describing the shared action or risk.` Each bullet should stay under about 25 words and group related comments into one theme.
  - `## Verdict`: the final section and final line of the body.
- Never turn `Recommendations` into a compressed findings list. Do not state the number of comments, enumerate files or symbols, reproduce mechanisms or fixes, or pack separate findings into semicolon/comma chains. If the comments do not share a precise theme, group them by broad impact such as correctness, authorization, maintainability, or test coverage.
- When there are no validated actionable findings, omit `Recommendations`; keep the summary brief and go directly to `Verdict`.
- A critical security, data-loss, or `⛔ Block` concern must remain explicit. When necessary, include one representative mechanism in `Recommendations`, while leaving exact technical detail and remediation inline. Ordinary request-change and nonblocking themes stay broad.
- Choose verdict severity from the actual review evidence, not comment count. Comments labeled or described as nonblocking (`nit`, `hint`, `clarity`, `suggestion`, `low`, `question`, or equivalent) do not by themselves justify requesting changes. Use `⚠️ Request changes` only when the reviewer or a validated finding identifies something that must be fixed before merge.
- Start the verdict with exactly one compact severity marker: `✅ LGTM.`, `⚠️ Request changes: <one concrete broad reason>.`, `⛔ Block: <one concrete broad reason>.`, or `❓ Incomplete review: <one concrete reason>.`
- Use `❓ Incomplete review:` when the reviewer output or artifacts show the reviewer likely stopped before completing the review. This verdict is about review confidence, not code quality.
- Do not emit XML-like tags, rating metadata, a postscript, or commentary after the verdict marker line.

Shape example (illustrative wording only):

```markdown
## Review Summary

This PR tightens an authorization flow and adds coverage for the new boundary. The implementation direction is sound, but one blocking concern remains.

## Recommendations

- **Authorization:** Resolve the trust-boundary concern identified inline.

## Verdict

⚠️ Request changes: resolve the blocking inline concern.
```

Do not instead copy the reviewer recap, announce the comment count, list identifiers, or repeat the recommendation in the verdict. For example, a bullet naming `src/auth.ts`, `canAccess()`, its exact failing branch, and its proposed test is an inline comment rewritten at the wrong level.

Use the context for trigger-comment answers and commenter handles. Use normal Markdown paragraphs separated by blank lines.
