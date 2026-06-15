#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { buildArtifactPaths, resolveWorkspace } from "../config/paths.js";
import { runCliMain } from "../lib/cli-main.js";
import {
  extractReviewArtifacts,
  outputPaths,
  renderGitHubStepSummary,
  writeReviewExtraction,
} from "../review/extract.js";

type ExtractArgs = {
  workspace?: string;
  runtimeDir?: string;
  outDir?: string;
  githubSummary: boolean;
  stdout: "manifest" | "stats" | "comments" | "transcript";
};

function parseArgs(argv: string[]): ExtractArgs {
  const args: ExtractArgs = {
    githubSummary: false,
    stdout: "manifest",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace") {
      args.workspace = argv[++index];
    } else if (arg === "--runtime-dir") {
      args.runtimeDir = argv[++index];
    } else if (arg === "--out-dir") {
      args.outDir = argv[++index];
    } else if (arg === "--github-summary") {
      args.githubSummary = true;
    } else if (arg === "--stdout") {
      const value = argv[++index];
      if (value !== "manifest" && value !== "stats" && value !== "comments" && value !== "transcript") {
        throw new Error("--stdout must be manifest, stats, comments, or transcript");
      }
      args.stdout = value;
    }
  }

  return args;
}

function printStdout(kind: ExtractArgs["stdout"], value: unknown): void {
  if (kind === "transcript") {
    process.stdout.write(String(value));
    return;
  }

  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const args = parseArgs(argv);
  const workspace = args.workspace || resolveWorkspace(env);
  const paths = buildArtifactPaths(env, workspace, args.runtimeDir);
  const writtenPaths = outputPaths(paths, args.outDir);
  const extraction = extractReviewArtifacts({ paths, env });
  const written = writeReviewExtraction(extraction, writtenPaths);
  const manifest = {
    generatedAt: extraction.generatedAt,
    outputs: written,
    stats: extraction.stats,
  };

  if (args.githubSummary) {
    const summaryFile = env.GITHUB_STEP_SUMMARY;
    if (!summaryFile) {
      throw new Error("GITHUB_STEP_SUMMARY is required when --github-summary is used");
    }
    appendFileSync(summaryFile, `${renderGitHubStepSummary(extraction)}\n`);
  }

  if (args.stdout === "stats") {
    printStdout(args.stdout, extraction.stats);
  } else if (args.stdout === "comments") {
    printStdout(args.stdout, extraction.comments);
  } else if (args.stdout === "transcript") {
    printStdout(args.stdout, extraction.transcript);
  } else {
    printStdout(args.stdout, manifest);
  }
}

runCliMain(import.meta.url, "review_extract", () => main());
