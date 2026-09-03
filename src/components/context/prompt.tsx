import { Block, Include } from "@aml-jsx/sdk"

import { REVIEW_CONTEXT_INLINE_LIMIT_BYTES } from "../../prompt-limits.js"
import { REVIEW_CONTEXT_PATHS } from "./files.js"

export type ReviewContextPromptProps = {
  diff?: boolean
  history?: boolean
  issues?: boolean
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
      <Block>{instruction}</Block>
      <Include path={path} maxBytes={REVIEW_CONTEXT_INLINE_LIMIT_BYTES} title={false} />
    </Block>
  )
}

/**
 * Projects selected materialized review files through AML's bounded Include boundary.
 *
 * Only `pr.md` is unconditional. Every potentially large enrichment is opt-in
 * so each phase must state which evidence it intends to give its Agent.
 */
export function ReviewContextPrompt({ diff = false, history = false, issues = false }: ReviewContextPromptProps) {
  const sections: PromptSection[] = [
    {
      label: "pull-request context and changed files",
      path: REVIEW_CONTEXT_PATHS.pullRequest,
      instruction: "Use the PR description, refs, commits, and changed-file inventory as intent and scope evidence.",
      tag: "pull-request-context"
    }
  ]

  if (issues) {
    sections.push({
      label: "referenced issue requirements and decision history",
      path: REVIEW_CONTEXT_PATHS.issues,
      instruction:
        "Treat issues marked closes as the active claimed contract and issues marked related as context only. Compare every closing issue's current description and acceptance criteria with the patch. Use compact edits, comments, and timeline as decision evidence, never as an implicit amendment.",
      tag: "referenced-issues-context"
    })
  }

  if (diff) {
    sections.push({
      label: "pull-request diff",
      path: REVIEW_CONTEXT_PATHS.diff,
      instruction: "Review before staging findings.",
      tag: "pull-request-diff"
    })
  }
  if (history) {
    sections.push({
      label: "pull-request history",
      path: REVIEW_CONTEXT_PATHS.history,
      instruction: "Check prior decisions and thread state before staging or retaining findings.",
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
