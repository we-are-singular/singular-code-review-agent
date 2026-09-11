import { opencodeAgent, type AgentProvider } from "@aml-jsx/sdk"
import { fileURLToPath } from "node:url"

export type CreateReviewProviderOptions = {
  model: string
  workspace: string
  usageDirectory?: string
}

/** Creates an AML provider using the ACP executables supplied by the runtime image. */
export function createReviewProvider(options: CreateReviewProviderOptions): AgentProvider {
  return opencodeAgent({
    ...(options.usageDirectory ? { command: fileURLToPath(new URL("./opencode-usage.sh", import.meta.url)) } : {}),
    // The authored AML Parallel tree owns review fan-out. Native delegation
    // cannot access a parent session's invocation-scoped finding Tools.
    config: {
      // These sessions are disposable; generating titles adds unrecorded model usage.
      agent: { title: { disable: true } },
      tools: { task: false }
    },
    directory: options.workspace,
    env: {
      ...(options.usageDirectory ? { REVIEW_OPENCODE_USAGE_DIRECTORY: options.usageDirectory } : {}),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
      // Reviewed repositories are untrusted input. Do not let their OpenCode
      // configuration start plugins or MCP processes with review credentials.
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      // Eval runs point this at an ephemeral OpenCode login copy.
      ...(process.env.XDG_DATA_HOME ? { XDG_DATA_HOME: process.env.XDG_DATA_HOME } : {})
    },
    model: options.model
  })
}
