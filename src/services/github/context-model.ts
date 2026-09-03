export const CONTEXT_HISTORY_TEXT_LIMIT = 500
export const CONTEXT_HISTORY_ENTRY_LIMIT = 200

/** One provider-neutral history record retained by deterministic application context. */
export type CompactHistoryEntry = {
  at: string | null
  kind: string
  reference: string | null
  actor: string | null
  state: string | null
  location: string | null
  body: string | null
  url: string | null
}

export type CompactHistory = {
  olderEntriesOmitted: number
  entries: CompactHistoryEntry[]
}

/** Complete current issue contract plus compact historical decision evidence. */
export type CompactIssueContext = {
  kind: "issue"
  relation: "closes" | "related" | "referenced"
  repository: string
  number: number
  url: string | null
  title: string
  description: string
  state: string | null
  author: string | null
  labels: string[]
  createdAt: string | null
  updatedAt: string | null
  history: CompactHistory
}

/** Structured PR context retained for deterministic application decisions. */
export type CompactPullRequestContext = {
  kind: "pull_request"
  repository: string
  number: number
  url: string | null
  title: string
  description: string
  state: string | null
  author: string | null
  labels: string[]
  assignees: string[]
  createdAt: string | null
  updatedAt: string | null
  baseRefName: string | null
  headRefName: string | null
  baseRefOid: string | null
  headRefOid: string | null
  draft: boolean
  reviewDecision: string | null
  changedFiles: string[]
  ignoredFiles: string[]
  commits: Array<{
    sha: string
    url: string | null
    author: string | null
    at: string | null
    subject: string
  }>
  history: CompactHistory
  issues: CompactIssueContext[]
}

/** Reduces untrusted historical prose to one useful model-facing line. */
export function compactContextText(value: unknown, limit = CONTEXT_HISTORY_TEXT_LIMIT): string {
  const text = String(value || "")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/```suggestion\s*([\s\S]*?)```/giu, " suggestion: $1 ")
    .replace(/```[^\n]*\s*([\s\S]*?)```/gu, " code: $1 ")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim()
  const suffix = "… (truncated)"
  return text.length <= limit ? text : `${text.slice(0, limit - suffix.length).trimEnd()}${suffix}`
}

/** Sorts compact history and applies an explicit source-specific entry limit. */
export function compactHistory(entries: CompactHistoryEntry[], limit?: number): CompactHistory {
  const ordered = entries.toSorted((left, right) => String(left.at || "").localeCompare(String(right.at || "")))
  const visible = limit === undefined ? ordered : ordered.slice(-limit)
  return {
    olderEntriesOmitted: ordered.length - visible.length,
    entries: visible
  }
}

/** Finds only explicit `related to` clauses; ordinary issue mentions remain cheap links. */
export function parseRelatedIssueReferences(body: string, repository: string) {
  const references = new Map<string, { repository: string; number: number }>()
  // First isolate explicit relationship clauses. Parsing every #123 in a PR
  // body would turn incidental links and examples into review requirements.
  const clausePattern = /\b(?:related\s+to|relates\s+to)\s*:?\s*(?<references>[^.;\n]+)/giu
  const referencePattern = /(?:(?<owner>[\w.-]+)\/(?<repo>[\w.-]+))?#(?<number>\d+)\b/gu

  for (const clause of body.matchAll(clausePattern)) {
    // A clause may list local and owner/repository-qualified references. The
    // map preserves first-seen order while collapsing repeated references.
    for (const match of String(clause.groups?.references || "").matchAll(referencePattern)) {
      const targetRepository =
        match.groups?.owner && match.groups.repo ? `${match.groups.owner}/${match.groups.repo}` : repository
      const number = Number(match.groups?.number)
      if (number > 0) {
        references.set(`${targetRepository}#${number}`, { repository: targetRepository, number })
      }
    }
  }
  return [...references.values()]
}
