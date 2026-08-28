import { codexAgent, opencodeAgent, type AgentProvider } from "@aml-jsx/sdk"

export type AmlReviewProvider = "opencode" | "codex"

export type CreateAmlReviewProviderOptions = {
  provider: AmlReviewProvider
  model: string
  workspace: string
  codexHome?: string
}

/** Creates an AML provider using the ACP executables supplied by the runtime image. */
export function createAmlReviewProvider(options: CreateAmlReviewProviderOptions): AgentProvider {
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
      // The shared image also serves src/, whose file config reads this name.
      // Pin it here so that config cannot override AML's selected model.
      OPENCODE_MODEL: options.model,
      // review_dry_run points this at its ephemeral OpenCode login copy.
      ...(process.env.XDG_DATA_HOME ? { XDG_DATA_HOME: process.env.XDG_DATA_HOME } : {})
    },
    model: options.model
  })
}

/** Parses the provider once at the executable composition boundary. */
export function parseAmlReviewProvider(value: string | undefined): AmlReviewProvider {
  const provider = (value || "opencode").trim().toLowerCase()
  if (provider === "opencode" || provider === "codex") {
    return provider
  }
  throw new Error(`AML review provider must be opencode or codex; received ${value}`)
}
