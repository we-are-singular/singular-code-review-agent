import { z } from "zod"

import { validateInlineComment, validateReply } from "../../src/review/queue.js"
import type { ReviewInlineCommentInput, ReviewReplyInput, ReviewValidationContext } from "../../src/review/types.js"

export const REVIEW_LANES = [
  "intent-contract",
  "standards-architecture",
  "code-path-bug-hunter",
  "correctness-risk-testing",
  "documentation-commentary",
  "maintainability-elegance"
] as const

export type ReviewLaneName = (typeof REVIEW_LANES)[number]

export const ReviewSeveritySchema = z.enum(["critical", "high", "low", "question", "hint", "nit"])
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>

const FindingEvidenceSchema = {
  severity: ReviewSeveritySchema.describe("Impact-based review severity"),
  title: z.string().trim().min(1).max(120).describe("Concise finding title"),
  body: z
    .string()
    .trim()
    .min(1)
    .max(1_400)
    .describe("Author-facing explanation and action without repeating the severity or title"),
  evidence: z.string().trim().min(1).max(2_000).describe("Concrete code path supporting the finding"),
  confidence: z.enum(["high", "medium", "low"])
}

export const InlineFindingSchema = z
  .object({
    kind: z.literal("inline"),
    ...FindingEvidenceSchema,
    comment_type: z.enum(["comment", "suggestion"]).optional(),
    path: z.string().min(1).describe("Repository-relative changed file path"),
    line: z.number().int().positive().describe("Changed line receiving the GitHub comment"),
    side: z.enum(["LEFT", "RIGHT"]),
    start_line: z.number().int().positive().optional(),
    start_side: z.enum(["LEFT", "RIGHT"]).optional()
  })
  .strict()

export const ReplyFindingSchema = z
  .object({
    kind: z.literal("reply"),
    ...FindingEvidenceSchema,
    to: z.number().int().positive().describe("Existing top-level review comment id")
  })
  .strict()

export const ReviewBlockerSchema = z
  .object({
    kind: z.literal("blocker"),
    severity: z.literal("critical"),
    title: FindingEvidenceSchema.title,
    body: FindingEvidenceSchema.body,
    evidence: FindingEvidenceSchema.evidence,
    confidence: z.literal("high")
  })
  .strict()

export const ReviewFindingSchema = z.discriminatedUnion("kind", [
  InlineFindingSchema,
  ReplyFindingSchema,
  ReviewBlockerSchema
])
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>
export type ReviewBlocker = z.infer<typeof ReviewBlockerSchema>

export const LaneAssessmentSchema = z
  .object({
    lane: z.enum(REVIEW_LANES),
    summary: z.string().trim().min(1).max(1_000)
  })
  .strict()

export type LaneAssessment = z.infer<typeof LaneAssessmentSchema>
export type StagedReviewFinding = { lane: ReviewLaneName; finding: ReviewFinding }

/** Formats one calibrated finding exactly as the pull-request author sees it. */
export function authorComment(finding: ReviewFinding): string {
  return `**${finding.severity}:** ${finding.title}\n\n${finding.body}`
}

/**
 * Owns the findings and completion summaries produced by parallel review lanes.
 * Anchors are rejected before audit, while cross-lane agreement remains visible
 * to the semantic deduplication pass.
 */
export class ReviewFindings {
  readonly #validation: ReviewValidationContext
  readonly #findings: StagedReviewFinding[] = []
  readonly #findingKeys = new Set<string>()
  readonly #assessments = new Map<ReviewLaneName, LaneAssessment>()

  constructor(validation: ReviewValidationContext) {
    this.#validation = validation
  }

  add(lane: ReviewLaneName, value: ReviewFinding): { duplicate: boolean } {
    const finding = ReviewFindingSchema.parse(value)
    const key = `${lane}\0${JSON.stringify(finding)}`
    if (this.#findingKeys.has(key)) {
      return { duplicate: true }
    }

    if (finding.kind === "inline") {
      const validated = validateInlineComment(
        {
          kind: finding.comment_type || "comment",
          path: finding.path,
          line: finding.line,
          side: finding.side,
          start_line: finding.start_line,
          start_side: finding.start_side,
          body: authorComment(finding)
        } satisfies ReviewInlineCommentInput,
        this.#validation
      )
      if (!validated.ok) {
        throw new Error(`cannot queue review comment: ${validated.reason}`)
      }
    } else if (finding.kind === "reply") {
      const validated = validateReply(
        { to: finding.to, body: authorComment(finding) } satisfies ReviewReplyInput,
        this.#validation
      )
      if (!validated.ok) {
        throw new Error(`cannot queue review reply: ${validated.reason}`)
      }
    }

    this.#findingKeys.add(key)
    this.#findings.push({ lane, finding })
    return { duplicate: false }
  }

  /** Records the lane's bounded natural-language handoff after its Agent returns. */
  complete(lane: ReviewLaneName, terminalText: string): void {
    const summary = terminalText.trim().slice(0, 1_000) || "Review completed without an additional assessment."
    const assessment = LaneAssessmentSchema.parse({ lane, summary })
    this.#assessments.set(lane, assessment)
  }

  staged(): readonly StagedReviewFinding[] {
    return structuredClone(this.#findings)
  }

  assessment(lane: ReviewLaneName): LaneAssessment {
    const assessment = this.#assessments.get(lane)
    if (!assessment) {
      throw new Error(`${lane} did not complete`)
    }
    return structuredClone(assessment)
  }

  completed(): LaneAssessment[] {
    const missing = REVIEW_LANES.filter(lane => !this.#assessments.has(lane))
    if (missing.length > 0) {
      throw new Error(`review lanes did not finish: ${missing.join(", ")}`)
    }

    return REVIEW_LANES.map(lane => this.assessment(lane))
  }
}
