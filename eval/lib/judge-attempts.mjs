import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { copyExistingFile, readJsonFile, writeJsonFile } from "./cache.mjs"

/** Preserves every paid judge invocation while maintaining latest-result aliases. */
export class JudgeAttemptStore {
  #attemptsDir
  #jobDir

  constructor(jobDir) {
    this.#jobDir = jobDir
    this.#attemptsDir = join(jobDir, "judge-attempts")
  }

  start() {
    mkdirSync(this.#attemptsDir, { recursive: true })
    this.#archiveLegacyAttempt()
    const number = Math.max(0, ...this.#attemptNumbers()) + 1
    const directory = join(this.#attemptsDir, `attempt-${number}`)
    mkdirSync(directory, { recursive: true })
    return {
      number,
      directory,
      files: {
        raw: join(directory, "judge.raw.jsonl"),
        stderr: join(directory, "judge.stderr.log"),
      },
    }
  }

  record(attempt, judgment) {
    const recorded = {
      ...judgment,
      attempt: attempt.number,
      files: attempt.files,
    }
    writeJsonFile(join(attempt.directory, "judge.json"), recorded)

    const files = {
      raw: join(this.#jobDir, "judge.raw.jsonl"),
      stderr: join(this.#jobDir, "judge.stderr.log"),
    }
    copyExistingFile(attempt.files.raw, files.raw)
    copyExistingFile(attempt.files.stderr, files.stderr)
    const canonical = {
      ...recorded,
      files,
      attempts: this.#attemptRecords(),
    }
    writeJsonFile(join(this.#jobDir, "judge.json"), canonical)
    return canonical
  }

  writeCache(entryDir, judgment) {
    const files = {
      raw: "judge.raw.jsonl",
      stderr: "judge.stderr.log",
    }
    copyExistingFile(judgment.files?.raw, join(entryDir, files.raw))
    copyExistingFile(judgment.files?.stderr, join(entryDir, files.stderr))
    return {
      ...judgment,
      files,
      attempts: this.#cacheAttempts(entryDir, judgment.attempts),
    }
  }

  restoreCache(entryDir, judgment) {
    const files = {
      raw: join(this.#jobDir, "judge.raw.jsonl"),
      stderr: join(this.#jobDir, "judge.stderr.log"),
    }
    copyExistingFile(join(entryDir, judgment.files?.raw || "judge.raw.jsonl"), files.raw)
    copyExistingFile(join(entryDir, judgment.files?.stderr || "judge.stderr.log"), files.stderr)
    return {
      ...judgment,
      files,
      attempts: this.#restoreAttempts(entryDir, judgment.attempts),
    }
  }

  #attemptNumbers() {
    if (!existsSync(this.#attemptsDir)) {
      return []
    }
    return readdirSync(this.#attemptsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => /^attempt-(\d+)$/u.exec(entry.name))
      .filter(Boolean)
      .map(match => Number(match[1]))
      .filter(Number.isSafeInteger)
      .sort((left, right) => left - right)
  }

  #attemptRecords() {
    return this.#attemptNumbers()
      .map(number => readJsonFile(join(this.#attemptsDir, `attempt-${number}`, "judge.json")))
      .filter(Boolean)
      .map(record => ({
        attempt: record.attempt,
        model: record.model,
        status: record.status,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        error: record.error,
        files: record.files,
      }))
  }

  #cacheAttempts(entryDir, attempts) {
    return this.#validAttempts(attempts).map(attempt => {
      const relativeDirectory = join("judge-attempts", `attempt-${attempt.attempt}`)
      const files = {
        raw: join(relativeDirectory, "judge.raw.jsonl"),
        stderr: join(relativeDirectory, "judge.stderr.log"),
      }
      copyExistingFile(attempt.files?.raw, join(entryDir, files.raw))
      copyExistingFile(attempt.files?.stderr, join(entryDir, files.stderr))
      return { ...attempt, files }
    })
  }

  #restoreAttempts(entryDir, attempts) {
    return this.#validAttempts(attempts).map(attempt => {
      const directory = join(this.#attemptsDir, `attempt-${attempt.attempt}`)
      const files = {
        raw: join(directory, "judge.raw.jsonl"),
        stderr: join(directory, "judge.stderr.log"),
      }
      mkdirSync(directory, { recursive: true })
      if (attempt.files?.raw) {
        copyExistingFile(join(entryDir, attempt.files.raw), files.raw)
      }
      if (attempt.files?.stderr) {
        copyExistingFile(join(entryDir, attempt.files.stderr), files.stderr)
      }
      const restored = { ...attempt, files }
      writeJsonFile(join(directory, "judge.json"), restored)
      return restored
    })
  }

  #validAttempts(attempts) {
    return (Array.isArray(attempts) ? attempts : [])
      .filter(attempt => attempt && Number.isSafeInteger(attempt.attempt) && attempt.attempt > 0)
      .sort((left, right) => left.attempt - right.attempt)
  }

  #archiveLegacyAttempt() {
    if (this.#attemptNumbers().length > 0) {
      return
    }
    const legacy = readJsonFile(join(this.#jobDir, "judge.json"))
    if (!legacy || legacy.cache?.hit) {
      return
    }

    const directory = join(this.#attemptsDir, "attempt-1")
    const files = {
      raw: join(directory, "judge.raw.jsonl"),
      stderr: join(directory, "judge.stderr.log"),
    }
    mkdirSync(directory, { recursive: true })
    copyExistingFile(join(this.#jobDir, "judge.raw.jsonl"), files.raw)
    copyExistingFile(join(this.#jobDir, "judge.stderr.log"), files.stderr)
    const archived = {
      ...legacy,
      attempt: 1,
      files,
    }
    delete archived.attempts
    writeJsonFile(join(directory, "judge.json"), archived)
  }
}
