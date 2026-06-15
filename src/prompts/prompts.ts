import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export type PromptName = "gate" | "review" | "audit" | "synthesis";

const PROMPT_DIR = dirname(fileURLToPath(import.meta.url));

function loadPrompt(name: PromptName): string {
  return readFileSync(join(PROMPT_DIR, `${name}.md`), "utf8");
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/gu, (_match, key: string) => values[key] || "");
}

/**
 * Builds the cheap routing prompt that decides whether a trigger should answer,
 * skip re-review, or escalate into the full review pipeline.
 */
export function buildGatePrompt(values: { contextFile: string; deltaFile: string }): string {
  return interpolate(loadPrompt("gate"), values);
}

/**
 * Builds the exploratory review prompt. It receives only artifact paths because
 * OpenCode gets the larger context/diff content as file attachments.
 */
export function buildReviewPrompt(values: { contextFile: string; diffFile: string }): string {
  return interpolate(loadPrompt("review"), values);
}

/**
 * Builds the queue audit phase prompt. Durable auditor scope lives in the
 * OpenCode `auditor` agent instructions.
 */
export function buildAuditPrompt(values: {
  workspace: string;
  queueFile: string;
  validatedFile: string;
  auditorContextFile: string;
  reviewerOutputFile: string;
}): string {
  const queuePromptPath = values.queueFile.startsWith(`${values.workspace}/`)
    ? relative(values.workspace, values.queueFile)
    : values.queueFile;
  return interpolate(loadPrompt("audit"), {
    ...values,
    queuePromptPath,
  });
}

/**
 * Builds the final-body synthesis phase prompt. Durable auditor scope lives in
 * the OpenCode `auditor` agent instructions.
 */
export function buildSynthesisPrompt(values: {
  reviewerOutputFile: string;
  validatedFile: string;
  auditorContextFile: string;
}): string {
  return interpolate(loadPrompt("synthesis"), values);
}
