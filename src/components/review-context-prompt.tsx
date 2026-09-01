import { Block, Include } from "@aml-jsx/sdk"

import { REVIEW_CONTEXT_INLINE_LIMIT_BYTES } from "./prompt-limits.js"
import { REVIEW_CONTEXT_PATHS } from "./review-context-files.js"

export type ReviewContextPromptProps = {
  diff?: boolean
  history?: boolean
}

type PromptSection = {
  label: string
  path: string
  instruction: string
  tag: string
}

function PromptContextSection({ instruction, label, path, tag }: PromptSection) {
  return (
    <Block tag={tag}>
      ### File: `{path}` — {label}
      <Block>{instruction} Do not fetch the same pull-request data again.</Block>
      <Include path={path} maxBytes={REVIEW_CONTEXT_INLINE_LIMIT_BYTES} title={false} />
    </Block>
  )
}

/** Projects selected materialized review files through AML's bounded Include boundary. */
export function ReviewContextPrompt({ diff = false, history = false }: ReviewContextPromptProps) {
  const sections: PromptSection[] = [
    {
      label: "pull-request context and changed files",
      path: REVIEW_CONTEXT_PATHS.pullRequest,
      instruction:
        "Use the PR description, refs, commits, and changed-file inventory as intent and scope evidence. If AML supplies a staged path instead of inline contents, read it before judging intent or scope.",
      tag: "pull-request-context"
    }
  ]

  if (diff) {
    sections.push({
      label: "pull-request diff",
      path: REVIEW_CONTEXT_PATHS.diff,
      instruction:
        "Review before staging findings. If AML supplies a staged path instead of inline contents, read it completely before staging findings.",
      tag: "pull-request-diff"
    })
  }
  if (history) {
    sections.push({
      label: "pull-request history",
      path: REVIEW_CONTEXT_PATHS.history,
      instruction:
        "Check prior decisions and thread state before staging or retaining findings. If AML supplies a staged path instead of inline contents, read it completely before staging or retaining findings.",
      tag: "pull-request-history"
    })
  }

  return (
    <Block>
      {sections.map(section => (
        <PromptContextSection {...section} />
      ))}
    </Block>
  )
}
