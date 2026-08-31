const OPENCODE_CREDENTIAL_ENVIRONMENT = [
  "ANTHROPIC_API_KEY",
  "CONTEXT7_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "Z_AI_API_KEY"
]

/** Maps one eval job to the production executable and its credential boundary. */
export function reviewerContainerConfig(job) {
  return {
    command: "/usr/local/bin/review_runner",
    environment: {
      REVIEW_MODEL: job.model
    },
    inheritedEnvironment: OPENCODE_CREDENTIAL_ENVIRONMENT,
    requiredEnvironment: [],
    usesOpenCodeAuth: true
  }
}
