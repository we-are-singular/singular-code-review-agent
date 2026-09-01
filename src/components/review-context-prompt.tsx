import { resolve } from "node:path"

import { Block } from "./block.js"
import { REVIEW_CONTEXT_PATHS } from "./review-context-files.js"
import { useReviewContext } from "./review-context.js"
import { textFileCache } from "../services/text-file-cache.js"

export type ReviewContextPromptProps = {
  files?: boolean
  diff?: boolean
  history?: boolean
}

type PromptSection = {
  label: string
  path: string
  instruction: string
  readInstruction: string
}

async function PromptContextSection({
  instruction,
  label,
  path,
  readInstruction,
  workspace
}: PromptSection & { workspace: string }) {
  const file = await textFileCache.read(resolve(workspace, path))
  const stats = `${file.characters.toLocaleString("en-US")} characters, ${file.words.toLocaleString("en-US")} words, ${file.lines.toLocaleString("en-US")} lines`

  if (file.content !== null) {
    return (
      <Block>
        ### File: `{path}` — {label} ({stats})<Block>{instruction}</Block>
        <Block>{file.content || "(Empty.)"}</Block>
      </Block>
    )
  }

  return (
    <Block>
      ### File: `{path}` — {label} ({stats})<Block>{readInstruction}</Block>
    </Block>
  )
}

/** Projects the materialized review files into an Agent prompt without duplicating large evidence. */
export function ReviewContextPrompt({ files = false, diff = false, history = false }: ReviewContextPromptProps) {
  const { github } = useReviewContext()
  const sections: PromptSection[] = [
    {
      label: files ? "pull-request context and changed files" : "pull-request context",
      path: REVIEW_CONTEXT_PATHS.pullRequest,
      instruction: files
        ? "Use the PR description, refs, commits, and changed-file inventory as intent and scope evidence."
        : "Use the PR description, refs, and commits as intent and scope evidence.",
      readInstruction: "Read before judging intent or scope."
    }
  ]

  if (diff) {
    sections.push({
      label: "pull-request diff",
      path: REVIEW_CONTEXT_PATHS.diff,
      instruction: "Review before staging findings.",
      readInstruction: "Read completely before staging findings."
    })
  }
  if (history) {
    sections.push({
      label: "pull-request history",
      path: REVIEW_CONTEXT_PATHS.history,
      instruction: "Check prior decisions and thread state before staging or retaining findings.",
      readInstruction: "Read completely before staging or retaining findings; check prior decisions and thread state."
    })
  }

  return (
    <Block>
      {sections.map(section => (
        <PromptContextSection {...section} workspace={github.request.workspace} />
      ))}
    </Block>
  )
}
