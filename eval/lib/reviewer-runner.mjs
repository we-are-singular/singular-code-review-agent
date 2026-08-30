const OPENCODE_CREDENTIAL_ENVIRONMENT = [
  "ANTHROPIC_API_KEY",
  "CONTEXT7_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "Z_AI_API_KEY"
]
const CODEX_CREDENTIAL_ENVIRONMENT = ["CONTEXT7_API_KEY"]
const CODEX_HOME = "/tmp/.singular-code-review/eval-runtime/codex-home"

/** Normalizes the Agent provider before it becomes part of eval job identity. */
export function normalizeReviewProvider(value) {
  const provider = String(value || "opencode").trim().toLowerCase()
  if (provider !== "opencode" && provider !== "codex") {
    throw new Error(`review provider must be opencode or codex, received ${value}`)
  }
  return provider
}

/** Maps one eval job to the production executable and its credential boundary. */
export function reviewerContainerConfig(job) {
  const provider = normalizeReviewProvider(job.provider)
  if (provider === "codex") {
    return {
      command: "/usr/local/bin/review_runner",
      environment: {
        REVIEW_CODEX_HOME: CODEX_HOME,
        REVIEW_PROVIDER: provider,
        REVIEW_MODEL: job.model
      },
      // Codex receives a disposable ChatGPT login, never API billing keys.
      inheritedEnvironment: CODEX_CREDENTIAL_ENVIRONMENT,
      requiredEnvironment: [],
      requiresCodexAuth: true
    }
  }

  return {
    command: "/usr/local/bin/review_runner",
    environment: {
      REVIEW_PROVIDER: provider,
      REVIEW_MODEL: job.model
    },
    inheritedEnvironment: OPENCODE_CREDENTIAL_ENVIRONMENT,
    requiredEnvironment: [],
    usesOpenCodeAuth: true
  }
}
