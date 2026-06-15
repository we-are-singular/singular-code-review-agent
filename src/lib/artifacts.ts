import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonFile } from "./json.js";

export type ArtifactPaths = {
  runtimeDir: string;
  queueFile: string;
  contextFile: string;
  reviewerContextFile: string;
  auditorContextFile: string;
  diffFile: string;
  validatedFile: string;
  payloadFile: string;
  transcriptFile: string;
  commentsFile: string;
  statsFile: string;
  reviewOutputFile: string;
  auditOutputFile: string;
  synthesisOutputFile: string;
  opencodeCapabilitiesFile: string;
  reviewSessionFile: string;
  auditorSessionFile: string;
};

/**
 * Small file writer for runtime artifacts. It owns parent-directory creation so
 * workflow code can write debug artifacts without path setup noise.
 */
export class ArtifactStore {
  readonly paths: ArtifactPaths;

  constructor(paths: ArtifactPaths) {
    this.paths = paths;
    mkdirSync(paths.runtimeDir, { recursive: true });
  }

  ensureParent(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
  }

  writeText(file: string, value: string): void {
    this.ensureParent(file);
    writeFileSync(file, value, { mode: 0o600 });
  }

  writeJson(file: string, value: unknown): void {
    writeJsonFile(file, value);
  }

  child(name: string): string {
    return join(this.paths.runtimeDir, name);
  }
}
