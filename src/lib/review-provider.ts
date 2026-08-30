import { codexAgent, opencodeAgent, type AgentProvider } from "@aml-jsx/sdk"

export type ReviewProvider = "opencode" | "codex"

export type CreateReviewProviderOptions = {
  provider: ReviewProvider
  model: string
  workspace: string
  codexHome?: string
}

/** Creates an AML provider using the ACP executables supplied by the runtime image. */
export function createReviewProvider(options: CreateReviewProviderOptions): AgentProvider {
  if (options.provider === "codex") {
    return codexAgent({
      model: options.model,
      workingDirectory: options.workspace,
      config: { model_reasoning_effort: "max" },
      ...(options.codexHome ? { env: { CODEX_HOME: options.codexHome } } : {})
    })
  }

  return opencodeAgent({
    // The authored AML Parallel tree owns review fan-out. Native delegation
    // cannot access a parent session's invocation-scoped finding Tools.
    config: {
      tools: { task: false }
    },
    directory: options.workspace,
    env: {
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
      // Eval runs point this at an ephemeral OpenCode login copy.
      ...(process.env.XDG_DATA_HOME ? { XDG_DATA_HOME: process.env.XDG_DATA_HOME } : {})
    },
    model: options.model
  })
}

/** Parses the provider once at the executable composition boundary. */
export function parseReviewProvider(value: string | undefined): ReviewProvider {
  const provider = (value || "opencode").trim().toLowerCase()
  if (provider === "opencode" || provider === "codex") {
    return provider
  }
  throw new Error(`review provider must be opencode or codex; received ${value}`)
}
