#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { buildArtifactPaths, resolveWorkspace } from "../config/paths.js";
import { runCliMain } from "../lib/cli-main.js";
import { readJsonFile, writeJsonFile } from "../lib/json.js";
import { createEmptyReviewContext } from "../review/context.js";
import {
  addInlineComment,
  addReply,
  addSuggestion,
  clearQueue,
  loadQueue,
  persistValidation,
  saveQueue,
  setConclusion,
  validateInlineComment,
  validateQueue,
} from "../review/queue.js";
import { type ReviewContext, type ReviewInlineCommentInput } from "../review/types.js";

type ParsedArgs = {
  _: string[];
  [key: string]: string | boolean | string[];
};

function usage(): void {
  process.stderr.write(`usage:
  review_comments add --path <path> --line <line> [--side LEFT|RIGHT] [--start-line <line>] [--start-side LEFT|RIGHT] --body <body>
  review_comments add --path <path> --line <line> [--side LEFT|RIGHT] [--start-line <line>] [--start-side LEFT|RIGHT] --body-file <file>
  review_comments add --path <path> --line <line> [--side LEFT|RIGHT] [--start-line <line>] [--start-side LEFT|RIGHT] --body-stdin
  review_comments suggest --path <path> --line <line> [--side LEFT|RIGHT] [--start-line <line>] [--start-side LEFT|RIGHT] --message <body> --replacement-file <file>
  review_comments suggest --path <path> --line <line> [--side LEFT|RIGHT] [--start-line <line>] [--start-side LEFT|RIGHT] --message-file <file> --replacement-file <file>
  review_comments suggest --path <path> --line <line> [--side LEFT|RIGHT] [--start-line <line>] [--start-side LEFT|RIGHT] --message-stdin --replacement-file <file>
  review_comments reply --to <review-comment-id> --body <body>
  review_comments reply --to <review-comment-id> --body-file <file>
  review_comments reply --to <review-comment-id> --body-stdin
  review_comments conclude --body <review-conclusion>
  review_comments conclude --body-file <file>
  review_comments conclude --body-stdin
  review_comments list
  review_comments status
  review_comments validate [--context <file>] [--output <file>]
  review_comments clear
`);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (!arg.startsWith("--")) {
      result._.push(arg);
      continue;
    }

    const key = arg.slice(2).replace(/-/gu, "_");
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }

  return result;
}

function stringOption(options: ParsedArgs, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function defaultFiles(env: NodeJS.ProcessEnv) {
  const workspace = resolveWorkspace(env);
  return buildArtifactPaths(env, workspace);
}

function queueFileFromOptions(options: ParsedArgs, env: NodeJS.ProcessEnv): string {
  return stringOption(options, "queue") || env.REVIEW_QUEUE_FILE || defaultFiles(env).queueFile;
}

function contextFileFromOptions(options: ParsedArgs, env: NodeJS.ProcessEnv): string {
  return stringOption(options, "context") || env.REVIEW_CONTEXT_FILE || defaultFiles(env).contextFile;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
    });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
}

export async function readBody(
  options: ParsedArgs,
  field = "body",
  stdinReader: () => Promise<string> = readStdin,
): Promise<string> {
  const file = stringOption(options, `${field}_file`);
  if (file) {
    return readFileSync(file, "utf8");
  }

  if (options[`${field}_stdin`] || options[field] === "-") {
    return stdinReader();
  }

  const direct = stringOption(options, field);
  if (direct) {
    return direct;
  }

  return options._.join(" ");
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function validateInlineTarget(input: ReviewInlineCommentInput, options: ParsedArgs, env: NodeJS.ProcessEnv): void {
  const contextFile = contextFileFromOptions(options, env);
  if (!existsSync(contextFile)) {
    return;
  }

  const context = readJsonFile<ReviewContext>(contextFile, createEmptyReviewContext());
  const result = validateInlineComment(input, context);
  if (!result.ok) {
    throw new Error(`invalid inline comment target: ${result.reason}`);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const [command, ...rest] = argv;
  const options = parseArgs(rest);
  const queueFile = queueFileFromOptions(options, env);

  if (command === "add") {
    const input = {
      path: stringOption(options, "path") || "",
      line: stringOption(options, "line") || "",
      start_line: stringOption(options, "start_line"),
      side: stringOption(options, "side"),
      start_side: stringOption(options, "start_side"),
      body: await readBody(options),
    };
    validateInlineTarget(input, options, env);
    printJson(addInlineComment(queueFile, input));
    return;
  }

  if (command === "suggest") {
    const replacementFile = stringOption(options, "replacement_file");
    if (!replacementFile) {
      throw new Error("--replacement-file is required");
    }

    const message = stringOption(options, "message") || (await readBody(options, "message"));
    const replacement = readFileSync(replacementFile, "utf8");
    const input = {
      path: stringOption(options, "path") || "",
      line: stringOption(options, "line") || "",
      start_line: stringOption(options, "start_line"),
      side: stringOption(options, "side"),
      start_side: stringOption(options, "start_side"),
      body: `${message}\n\n\`\`\`suggestion\n${replacement.replace(/\s+$/u, "")}\n\`\`\``,
    };
    validateInlineTarget(input, options, env);
    printJson(
      addSuggestion(queueFile, {
        path: input.path,
        line: input.line,
        start_line: input.start_line,
        side: input.side,
        start_side: input.start_side,
        message,
        replacement,
      }),
    );
    return;
  }

  if (command === "reply") {
    printJson(addReply(queueFile, { to: stringOption(options, "to"), body: await readBody(options) }));
    return;
  }

  if (command === "conclude") {
    printJson(setConclusion(queueFile, await readBody(options)));
    return;
  }

  if (command === "list") {
    printJson(loadQueue(queueFile));
    return;
  }

  if (command === "clear") {
    printJson(clearQueue(queueFile));
    return;
  }

  if (command === "validate") {
    const context = readJsonFile<ReviewContext>(contextFileFromOptions(options, env), createEmptyReviewContext());
    const validated = validateQueue(loadQueue(queueFile), context);
    const output = stringOption(options, "output");
    if (output) {
      writeJsonFile(output, validated);
    }
    persistValidation(queueFile, validated);
    printJson(validated);
    return;
  }

  if (command === "status") {
    const context = readJsonFile<ReviewContext>(contextFileFromOptions(options, env), createEmptyReviewContext());
    const queue = loadQueue(queueFile);
    const validated = validateQueue(queue, context);
    printJson({
      queue_file: queueFile,
      queued_inline: queue.inlineComments.length,
      queued_replies: queue.replies.length,
      has_conclusion: Boolean(validated.conclusion),
      valid_inline: validated.inlineComments.length,
      valid_replies: validated.replies.length,
      dropped: validated.dropped.length,
      submit_would_be_empty: validated.inlineComments.length === 0 && validated.replies.length === 0 && !validated.conclusion,
    });
    return;
  }

  if (command === "payload-comments") {
    const context = readJsonFile<ReviewContext>(contextFileFromOptions(options, env), createEmptyReviewContext());
    printJson(
      validateQueue(loadQueue(queueFile), context).inlineComments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
        ...(comment.start_line === undefined ? {} : { start_line: comment.start_line, start_side: comment.start_side }),
      })),
    );
    return;
  }

  // Allow tests and manual repairs to persist a modified queue without exposing a separate old API.
  if (command === "replace") {
    const file = stringOption(options, "file");
    if (!file) {
      throw new Error("--file is required");
    }
    saveQueue(queueFile, readJsonFile(file, loadQueue(queueFile)));
    printJson(loadQueue(queueFile));
    return;
  }

  usage();
  throw new Error("unknown or missing command");
}

runCliMain(import.meta.url, "review_comments", () => main());
