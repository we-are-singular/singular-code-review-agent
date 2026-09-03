import { REVIEW_INCLUDE_MAX_BYTES } from "./config.js"

/** Prevents bundled review policies from growing into unexpectedly large model instructions. */
export const REVIEW_POLICY_INCLUDE_LIMIT_BYTES = REVIEW_INCLUDE_MAX_BYTES

/** Lets AML stage oversized request evidence instead of injecting it directly into a prompt. */
export const REVIEW_CONTEXT_INLINE_LIMIT_BYTES = 50_000
