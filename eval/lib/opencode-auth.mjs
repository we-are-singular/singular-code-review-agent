import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const OPENCODE_AUTH_FILES = ["auth.json", "account.json"]

/**
 * Stages a writable, request-local copy of the host OpenCode login.
 *
 * OpenCode may refresh either file during a session. Copying both into the
 * isolated XDG data directory keeps those writes away from the host and lets
 * callers remove the credentials before retaining any diagnostic scratch.
 */
export function stageOpenCodeAuth(dataHome, environment = process.env) {
  if (String(environment.OPENCODE_API_KEY || "").trim()) {
    return []
  }

  const sourceDataHome = String(environment.XDG_DATA_HOME || "").trim() || join(homedir(), ".local", "share")
  const sourceDirectory = join(sourceDataHome, "opencode")
  const sourceAuth = join(sourceDirectory, "auth.json")
  if (!existsSync(sourceAuth)) {
    throw new Error("OpenCode authentication is required; set OPENCODE_API_KEY or run opencode auth login")
  }

  const targetDirectory = join(dataHome, "opencode")
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 })
  chmodSync(targetDirectory, 0o700)

  const staged = []
  for (const file of OPENCODE_AUTH_FILES) {
    const source = join(sourceDirectory, file)
    if (!existsSync(source)) {
      continue
    }
    const target = join(targetDirectory, file)
    copyFileSync(source, target)
    chmodSync(target, 0o600)
    staged.push(target)
  }
  return staged
}
