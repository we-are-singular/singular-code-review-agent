const REVIEW_RUNNERS = ["src", "aml"]
const AML_OPENCODE_CREDENTIAL_ENVIRONMENT = [
  "ANTHROPIC_API_KEY",
  "CONTEXT7_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "Z_AI_API_KEY",
]
const AML_CODEX_CREDENTIAL_ENVIRONMENT = ["CONTEXT7_API_KEY"]
const CODEX_HOME = "/tmp/.singular-code-review/eval-runtime/codex-home"

/** Normalizes the implementation selector before it becomes job identity. */
export function normalizeReviewRunner(value) {
  const runner = String(value || "src").trim().toLowerCase()
  if (!REVIEW_RUNNERS.includes(runner)) {
    throw new Error(`runner must be src or aml, received ${value}`)
  }
  return runner
}

/** Normalizes the AML Agent provider before it becomes job identity. */
export function normalizeAmlReviewProvider(value) {
  const provider = String(value || "opencode").trim().toLowerCase()
  if (provider !== "opencode" && provider !== "codex") {
    throw new Error(`AML provider must be opencode or codex, received ${value}`)
  }
  return provider
}

/**
 * Maps one eval job to the packaged executable and non-secret environment that
 * review_dry_run must forward into the selected reviewer process.
 */
export function reviewerContainerConfig(job) {
  if (job.runner !== "aml") {
    return {
      command: "/usr/local/bin/review_runner",
      // Preserve the production retry count without silently changing the
      // model on attempt three of a nominal single-model benchmark.
      environment: {
        OPENCODE_MODEL: job.model,
        OPENCODE_MODEL_FALLBACK: job.model,
      },
      inheritedEnvironment: ["OPENCODE_API_KEY", "OPENROUTER_API_KEY"],
      requiredEnvironment: [],
      usesOpenCodeAuth: true,
    }
  }

  const provider = normalizeAmlReviewProvider(job.provider)
  if (provider === "codex") {
    return {
      command: "/usr/local/bin/aml_review",
      environment: {
        AML_CODEX_HOME: CODEX_HOME,
        AML_REVIEW_PROVIDER: provider,
        AML_REVIEW_MODEL: job.model,
      },
      // The eval boundary stages ChatGPT auth under AML_CODEX_HOME. API keys
      // stay outside the container so Codex cannot silently switch billing.
      inheritedEnvironment: AML_CODEX_CREDENTIAL_ENVIRONMENT,
      requiredEnvironment: [],
      requiresCodexAuth: true,
    }
  }

  return {
    command: "/usr/local/bin/aml_review",
    environment: {
      AML_REVIEW_PROVIDER: provider,
      AML_REVIEW_MODEL: job.model,
    },
    // Forward only the explicit AML credential surface. The selected Agent
    // provider receives the matching populated values, never the host env.
    inheritedEnvironment: AML_OPENCODE_CREDENTIAL_ENVIRONMENT,
    requiredEnvironment: [],
    usesOpenCodeAuth: true,
  }
}
