import { readFile, stat } from "node:fs/promises"

// Files within this bound keep their text for prompt reuse; larger files retain only their computed metadata.
const FILE_CONTENT_CACHE_LIMIT = 50_000
// One process can run many reviews in tests or embedding hosts, so old path entries cannot accumulate indefinitely.
const FILE_CACHE_ENTRY_LIMIT = 128

export type CachedTextFile = {
  content: string | null
  characters: number
  words: number
  lines: number
}

type CacheEntry = {
  signature: string
  read: Promise<CachedTextFile>
}

/** Shares unchanged text-file reads and metadata calculations across concurrent consumers. */
class TextFileCache {
  // Pending promises are cached too, so parallel review lanes share the first disk read instead of racing it.
  readonly #files = new Map<string, CacheEntry>()

  async read(path: string) {
    const metadata = await stat(path)
    const signature = `${metadata.size}:${metadata.mtimeMs}`
    const cached = this.#files.get(path)
    if (cached?.signature === signature) return cached.read

    const read = readFile(path, "utf8")
      .then(value => {
        const normalized = value.trimEnd()
        const trimmed = normalized.trim()
        const result = {
          // Empty files remain ""; null means the file was counted but is too large to retain in memory.
          content: normalized.length <= FILE_CONTENT_CACHE_LIMIT ? normalized : null,
          characters: normalized.length,
          words: trimmed ? trimmed.split(/\s+/u).length : 0,
          lines: normalized ? normalized.split("\n").length : 0
        }
        return result
      })
      .catch(error => {
        if (this.#files.get(path)?.read === read) this.#files.delete(path)
        throw error
      })

    if (!cached && this.#files.size >= FILE_CACHE_ENTRY_LIMIT) {
      // Map insertion order gives this small process-local cache a sufficient FIFO eviction policy.
      const oldestPath = this.#files.keys().next().value
      if (oldestPath) this.#files.delete(oldestPath)
    }
    this.#files.set(path, { signature, read })
    return read
  }
}

/** Process-local cache shared by application-owned text-file consumers. */
export const textFileCache = new TextFileCache()
