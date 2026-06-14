#!/usr/bin/env node
import { createGitHubClient, createDryRunGitHubClient } from "../clients/github.js";
import { createCliOpenCodeClient } from "../clients/opencode.js";
import { loadRunnerConfig } from "../config/env.js";
import { ArtifactStore } from "../lib/artifacts.js";
import { createLogger } from "../lib/logger.js";
import { runReviewWorkflow } from "../review/workflow.js";
import { runCliMain } from "../lib/cli-main.js";

/**
 * Composition root for the production review command. All long-lived runtime
 * dependencies are constructed here and injected into the workflow.
 */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const config = loadRunnerConfig(env, argv);
  const logger = createLogger();
  const artifacts = new ArtifactStore(config.artifacts);
  const liveGitHub = createGitHubClient({ token: config.githubToken, repository: config.repository });
  const github = config.dryRun ? createDryRunGitHubClient(liveGitHub, artifacts) : liveGitHub;
  const opencode = createCliOpenCodeClient({ logger });

  const result = await runReviewWorkflow({
    config,
    artifacts,
    github,
    opencode,
    logger,
  });

  logger.info("review runner finished", result);
}

runCliMain(import.meta.url, "review_runner", () => main());
