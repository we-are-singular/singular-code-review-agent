import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function sha256Json(value) {
  return sha256Text(JSON.stringify(value));
}

export function sha256File(file) {
  return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "";
}

export function cacheEntryDir(root, key) {
  return join(root, key.slice(0, 2), key);
}

export function readJsonFile(file, fallback = null) {
  if (!existsSync(file)) {
    return fallback;
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeJsonFile(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function copyExistingFile(source, target) {
  if (!source || !existsSync(source)) {
    return false;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  return true;
}

export function fileSize(file) {
  return existsSync(file) ? statSync(file).size : 0;
}
