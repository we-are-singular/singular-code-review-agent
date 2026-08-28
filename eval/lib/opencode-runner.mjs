import { rmSync } from "node:fs";

function textFromJsonEvent(value, depth = 0) {
  if (!value || depth > 6 || typeof value !== "object") {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((item) => textFromJsonEvent(item, depth + 1)).filter(Boolean).join("");
  }
  if (typeof value.text === "string" && (value.type === "text" || value.type === undefined)) {
    return value.text;
  }
  for (const key of ["part", "event", "properties", "message", "data"]) {
    if (value[key] && typeof value[key] === "object") {
      const text = textFromJsonEvent(value[key], depth + 1);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

export function extractRenderedText(jsonl) {
  const chunks = [];
  for (const line of String(jsonl || "").split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const text = textFromJsonEvent(JSON.parse(line));
      if (text) {
        chunks.push(text);
      }
    } catch {
      // Keep raw JSONL as the source of truth when an event shape changes.
    }
  }
  return chunks.join("").trim();
}

export function cleanupScratch(path, keepScratch) {
  if (!keepScratch) {
    rmSync(path, { recursive: true, force: true });
  }
}
