#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createGitHubClient } from "../clients/github.js";
import { runCliMain } from "../lib/cli-main.js";
import { getErrorMessage } from "../lib/errors.js";
import { REVIEW_BOT_LOGIN } from "../review/types.js";

function output(name: string, value: string, env: NodeJS.ProcessEnv): void {
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function continueReview(message: string, env: NodeJS.ProcessEnv): void {
  output("should_review", "true", env);
  process.stderr.write(`[singular-code-review] ${message}\n`);
}

function skipReview(message: string, env: NodeJS.ProcessEnv): void {
  output("should_review", "false", env);
  process.stderr.write(`[singular-code-review] ${message}\n`);
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * Uses an `eyes` reaction as an idempotency marker for mention-triggered runs.
 * Reaction failures are non-fatal so transient permission gaps do not block a
 * legitimate review request.
 */
export async function acknowledgeReviewRequest(options: {
  github: Pick<ReturnType<typeof createGitHubClient>, "listIssueCommentReactions" | "createIssueCommentReaction">;
  botLogin: string;
  commentId: number | null;
}): Promise<{ shouldReview: boolean; message: string }> {
  if (!options.commentId) {
    return { shouldReview: true, message: "direct pull request trigger; continuing review" };
  }
  let reactions;
  try {
    reactions = await options.github.listIssueCommentReactions(options.commentId);
  } catch (error) {
    return { shouldReview: true, message: `could not list trigger reactions; continuing review: ${getErrorMessage(error)}` };
  }

  if (reactions.some((reaction) => reaction.content === "eyes" && reaction.user?.login === options.botLogin)) {
    // Another in-flight or completed workflow already acknowledged this exact
    // trigger comment.
    return { shouldReview: false, message: `trigger comment already acknowledged by ${options.botLogin}; skipping review` };
  }

  try {
    await options.github.createIssueCommentReaction(options.commentId, "eyes");
  } catch (error) {
    return { shouldReview: true, message: `could not acknowledge trigger comment; continuing review: ${getErrorMessage(error)}` };
  }

  return { shouldReview: true, message: `trigger comment acknowledged by ${options.botLogin}; continuing review` };
}

export async function main(_argv = process.argv.slice(2), env = process.env): Promise<void> {
  const repository = required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const token = required(env.GH_TOKEN || env.GITHUB_TOKEN, "GH_TOKEN");
  const botLogin = env.BOT_LOGIN || REVIEW_BOT_LOGIN;
  const commentId = env.COMMENT_ID ? Number(env.COMMENT_ID) : null;
  const github = createGitHubClient({ token, repository });
  const result = await acknowledgeReviewRequest({ github, botLogin, commentId });

  if (result.shouldReview) {
    continueReview(result.message, env);
  } else {
    skipReview(result.message, env);
  }
}

runCliMain(import.meta.url, "review_ack", () => main());
