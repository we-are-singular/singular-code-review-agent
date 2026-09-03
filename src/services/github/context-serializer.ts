import type { ReviewDiff } from "../../lib/review-diff.js"
import { type CompactHistory, type CompactIssueContext, type CompactPullRequestContext } from "./context-model.js"

// `I` is intentionally outside git's tracked-file states: it means the file
// changed, but its lockfile or binary patch was omitted from review context.
const COMPACT_FILE_STATUS = { added: "A", modified: "M", removed: "D", ignored: "I" } as const

/**
 * Serializes structured history into one self-describing line per event.
 *
 * URLs are deliberately omitted because each line retains its reference and
 * body; supported top-level comments and commits can still be expanded by id.
 */
export function serializeHistory(history: CompactHistory) {
  return {
    olderEntriesOmitted: history.olderEntriesOmitted,
    entries: history.entries.map(entry => {
      const reference = entry.reference ? `${entry.kind} ${entry.reference}` : entry.kind
      const metadata = [
        entry.at || "unknown-time",
        reference,
        entry.actor ? `@${entry.actor}` : null,
        entry.state,
        entry.location
      ]
        .filter(Boolean)
        .join(" | ")
      return entry.body ? `${metadata} — ${entry.body}` : metadata
    })
  }
}

/** Serializes one diff file as a git-status-like line with compact churn counts. */
export function serializeFileChange(
  status: "added" | "modified" | "removed" | "ignored",
  path: string,
  additions = 0,
  deletions = 0
): string {
  const marker = COMPACT_FILE_STATUS[status]
  const counts = [additions > 0 ? `+${additions}` : null, deletions > 0 ? `-${deletions}` : null]
    .filter(Boolean)
    .join(" ")
  return `${marker} ${path}${counts ? ` ${counts}` : ""}`
}

/** Serializes one normalized commit without its repeated object field names. */
export function serializeCommit(commit: CompactPullRequestContext["commits"][number]): string {
  return `${commit.sha.slice(0, 12)} | ${commit.at || "unknown-time"} | ${commit.author ? `@${commit.author}` : "unknown"} | ${commit.subject}`
}

/** Preserves the current issue contract while serializing repeated history fields. */
export function serializeIssueContext(context: CompactIssueContext) {
  return {
    kind: context.kind,
    relation: context.relation,
    repository: context.repository,
    number: context.number,
    url: context.url,
    title: context.title,
    description: context.description,
    state: context.state,
    author: context.author,
    labels: context.labels,
    createdAt: context.createdAt,
    updatedAt: context.updatedAt,
    history: serializeHistory(context.history)
  }
}

/**
 * Serializes one PR for an Agent without retaining another application model.
 *
 * The structured context and parsed diff remain authoritative. Repeated fields
 * become self-contained lines only while crossing the Tool or renderer boundary.
 */
export function serializePullRequestContext(
  context: CompactPullRequestContext,
  diff: Pick<ReviewDiff, "files" | "ignoredFiles">
) {
  const files = [
    ...diff.files.map(file =>
      serializeFileChange(file.status, file.path, file.addedLines.length, file.deletedLines.length)
    ),
    // Ignored blocks have already left the filtered diff, so their exact churn
    // is unavailable. `I` reports that omission instead of inventing counts.
    ...diff.ignoredFiles.map(path => serializeFileChange("ignored", path))
  ]
  const commits = context.commits.map(serializeCommit)

  return {
    kind: context.kind,
    repository: context.repository,
    number: context.number,
    url: context.url,
    title: context.title,
    description: context.description,
    state: context.state,
    author: context.author,
    labels: context.labels,
    assignees: context.assignees,
    createdAt: context.createdAt,
    updatedAt: context.updatedAt,
    baseRefName: context.baseRefName,
    headRefName: context.headRefName,
    baseRefOid: context.baseRefOid,
    headRefOid: context.headRefOid,
    draft: context.draft,
    reviewDecision: context.reviewDecision,
    files,
    commits,
    history: serializeHistory(context.history),
    issues: context.issues.map(serializeIssueContext)
  }
}
