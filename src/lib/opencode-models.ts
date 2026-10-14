import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

/** OpenCode's own catalog origin when OPENCODE_MODELS_URL is unset. */
const DEFAULT_MODELS_URL = "https://models.opencode.ai"

/** Bounds the startup delay; a slow catalog falls back to OpenCode's per-Agent loading. */
const FETCH_TIMEOUT_MS = 5_000

/**
 * Providers whose advertised models are exactly their catalog entries. Plugins
 * replace other providers' model lists at runtime (Copilot, Codex, ...), so the
 * catalog cannot prove those models unavailable.
 */
const CATALOG_PROVIDERS = new Set(["opencode", "opencode-go"])

/** OpenCode's `truthy()` for process flags such as OPENCODE_DISABLE_MODELS_FETCH. */
function openCodeFlag(value: string | undefined): boolean {
  return ["true", "1"].includes(value?.toLowerCase() || "")
}

/**
 * OpenCode's Effect `Config.boolean` for runtime flags such as OPENCODE_ENABLE_EXPERIMENTAL_MODELS.
 * It is case-sensitive: OpenCode exits on values like "TRUE", so those must not count as enabled.
 */
function openCodeConfigFlag(value: string | undefined): boolean {
  return ["true", "yes", "on", "1", "y"].includes(value || "")
}

// Checks only the fields read here; OpenCode parses the pinned file itself.
const catalogSchema = z
  .record(z.string(), z.looseObject({ models: z.record(z.string(), z.looseObject({ status: z.string().optional() })) }))
  .refine(catalog => Object.keys(catalog).length > 0, "catalog has no providers")

/**
 * One OpenCode model catalog shared by every Agent in a review run.
 *
 * AML gives each Agent a fresh XDG cache, so without a pinned file each Agent
 * races OpenCode's background refresh and may advertise only the bundled snapshot.
 */
export class OpenCodeModelCatalog {
  readonly path: string
  readonly #source: string
  readonly #directory: string
  readonly #statuses: ReadonlyMap<string, string | undefined>
  readonly #experimentalModels: boolean

  private constructor(options: {
    source: string
    directory: string
    path: string
    catalog: z.infer<typeof catalogSchema>
    experimentalModels: boolean
  }) {
    this.#source = options.source
    this.#directory = options.directory
    this.path = options.path
    // Keys match OpenCode's advertised "<provider>/<model>" values.
    this.#statuses = new Map(
      Object.entries(options.catalog).flatMap(([provider, info]) =>
        Object.entries(info.models).map(([model, entry]) => [`${provider}/${model}`, entry.status] as const)
      )
    )
    this.#experimentalModels = options.experimentalModels
  }

  /**
   * Fetches the catalog OpenCode would refresh to and writes it to a review-owned file.
   * Returns null when the environment already fixes the catalog; throws when the fetch fails.
   */
  static async pin(env: NodeJS.ProcessEnv, options: { timeoutMs?: number } = {}): Promise<OpenCodeModelCatalog | null> {
    // An operator-supplied file or disabled fetching already gives every Agent the same catalog.
    if (env.OPENCODE_MODELS_PATH || openCodeFlag(env.OPENCODE_DISABLE_MODELS_FETCH)) {
      return null
    }
    const source = `${env.OPENCODE_MODELS_URL || DEFAULT_MODELS_URL}/api.json`
    let text: string
    let catalog: z.infer<typeof catalogSchema>
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS) })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      text = await response.text()
      const parsed = catalogSchema.safeParse(JSON.parse(text))
      if (!parsed.success) {
        throw new Error("response is not a model catalog")
      }
      catalog = parsed.data
    } catch (cause) {
      throw new Error(`cannot load ${source}`, { cause })
    }

    const directory = mkdtempSync(join(tmpdir(), "review-opencode-models-"))
    const path = join(directory, "models.json")
    try {
      // OpenCode reads the response exactly as its own refresh would have cached it.
      writeFileSync(path, text)
    } catch (cause) {
      rmSync(directory, { recursive: true, force: true })
      throw cause
    }
    return new OpenCodeModelCatalog({
      source,
      directory,
      path,
      catalog,
      experimentalModels: openCodeConfigFlag(env.OPENCODE_ENABLE_EXPERIMENTAL_MODELS)
    })
  }

  /** Explains why OpenCode will not advertise the model, or returns null when it will or cannot be judged. */
  unavailableReason(model: string): string | null {
    const provider = model.split("/")[0] || ""
    if (!CATALOG_PROVIDERS.has(provider)) {
      return null
    }
    if (!this.#statuses.has(model)) {
      return `model "${model}" is not in the OpenCode model catalog from ${this.#source}`
    }
    // OpenCode removes these entries before advertising session models.
    const status = this.#statuses.get(model)
    if (status === "deprecated") {
      return `model "${model}" is deprecated in the OpenCode model catalog from ${this.#source}`
    }
    if (status === "alpha" && !this.#experimentalModels) {
      return `model "${model}" is an alpha model; set OPENCODE_ENABLE_EXPERIMENTAL_MODELS=true to use it`
    }
    return null
  }

  close(): void {
    rmSync(this.#directory, { recursive: true, force: true })
  }
}
