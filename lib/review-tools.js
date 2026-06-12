const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_QUEUE_FILE = "/tmp/review_queue.json";
const DEFAULT_CONTEXT_FILE = "/tmp/review_context.json";
const DEFAULT_DIFF_FILE = "/tmp/pr.diff";

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) {
    return fallback;
  }

  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) {
    return fallback;
  }

  return JSON.parse(raw);
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpFile = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpFile, file);
}

function normalizeDiffPath(rawPath) {
  if (!rawPath || rawPath === "/dev/null") {
    return null;
  }

  if (rawPath.startsWith("a/") || rawPath.startsWith("b/")) {
    return rawPath.slice(2);
  }

  return rawPath;
}

function parseUnifiedDiff(diffText) {
  const files = new Map();
  let currentPath = null;
  let inHunk = false;
  let newLine = 0;

  function fileInfo(filePath) {
    if (!files.has(filePath)) {
      files.set(filePath, {
        path: filePath,
        addedLines: new Set(),
        rightLines: new Set()
      });
    }
    return files.get(filePath);
  }

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      currentPath = null;
      inHunk = false;
      continue;
    }

    if (line.startsWith("+++ ")) {
      currentPath = normalizeDiffPath(line.slice(4).trim());
      inHunk = false;
      continue;
    }

    if (line.startsWith("@@ ")) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/);
      inHunk = Boolean(match);
      newLine = match ? Number(match[1]) - 1 : 0;
      continue;
    }

    if (!inHunk || !currentPath) {
      continue;
    }

    if (line.startsWith("\\")) {
      continue;
    }

    const marker = line[0];
    if (marker === " ") {
      newLine += 1;
      fileInfo(currentPath).rightLines.add(newLine);
    } else if (marker === "+") {
      newLine += 1;
      const info = fileInfo(currentPath);
      info.rightLines.add(newLine);
      info.addedLines.add(newLine);
    }
  }

  return {
    files: Array.from(files.values()).map((info) => ({
      path: info.path,
      addedLines: Array.from(info.addedLines).sort((a, b) => a - b),
      rightLines: Array.from(info.rightLines).sort((a, b) => a - b)
    }))
  };
}

function validCommentRangesFromDiff(diffText) {
  const parsed = parseUnifiedDiff(diffText);
  return Object.fromEntries(
    parsed.files.map((file) => [
      file.path,
      {
        added_lines: file.addedLines,
        right_lines: file.rightLines
      }
    ])
  );
}

function createEmptyQueue() {
  return {
    version: 1,
    inlineComments: [],
    replies: [],
    dropped: [],
    updatedAt: new Date().toISOString()
  };
}

function queueFileFromEnv() {
  return process.env.REVIEW_QUEUE_FILE || process.env.REVIEW_STAGED_FILE || DEFAULT_QUEUE_FILE;
}

function contextFileFromEnv() {
  return process.env.REVIEW_CONTEXT_FILE || DEFAULT_CONTEXT_FILE;
}

function diffFileFromEnv() {
  return process.env.REVIEW_DIFF_FILE || DEFAULT_DIFF_FILE;
}

function loadQueue(file = queueFileFromEnv()) {
  const value = readJsonFile(file, createEmptyQueue());
  if (Array.isArray(value)) {
    return {
      ...createEmptyQueue(),
      inlineComments: value
    };
  }

  return {
    ...createEmptyQueue(),
    ...value,
    inlineComments: Array.isArray(value.inlineComments) ? value.inlineComments : [],
    replies: Array.isArray(value.replies) ? value.replies : [],
    dropped: Array.isArray(value.dropped) ? value.dropped : []
  };
}

function saveQueue(queue, file = queueFileFromEnv()) {
  writeJsonFile(file, {
    ...queue,
    updatedAt: new Date().toISOString()
  });
}

function clearQueue(file = queueFileFromEnv()) {
  const queue = createEmptyQueue();
  saveQueue(queue, file);
  return queue;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function validateRepoPath(reviewPath) {
  if (!reviewPath || typeof reviewPath !== "string" || reviewPath.includes("\0")) {
    throw new Error("path must be a non-empty repository-relative path");
  }

  if (path.isAbsolute(reviewPath)) {
    throw new Error("path must be repository-relative, not absolute");
  }
}

function normalizeInlineComment(input) {
  validateRepoPath(input.path);
  const line = positiveInteger(input.line, "line");
  const startLine = input.start_line === undefined ? undefined : positiveInteger(input.start_line, "start-line");
  const body = String(input.body || "").trim();

  if (!body) {
    throw new Error("body must be non-empty");
  }

  if (startLine !== undefined && startLine > line) {
    throw new Error("start-line must be less than or equal to line");
  }

  const comment = {
    kind: input.kind || "comment",
    path: input.path,
    line,
    side: input.side || "RIGHT",
    body
  };

  if (startLine !== undefined && startLine !== line) {
    comment.start_line = startLine;
    comment.start_side = input.start_side || "RIGHT";
  }

  return comment;
}

function addInlineComment(input, file = queueFileFromEnv()) {
  const queue = loadQueue(file);
  const comment = normalizeInlineComment(input);
  queue.inlineComments.push(comment);
  saveQueue(queue, file);
  return comment;
}

function addReply(input, file = queueFileFromEnv()) {
  const to = positiveInteger(input.to || input.comment_id, "to");
  const body = String(input.body || "").trim();
  if (!body) {
    throw new Error("body must be non-empty");
  }

  const reply = { to, body };
  const queue = loadQueue(file);
  queue.replies.push(reply);
  saveQueue(queue, file);
  return reply;
}

function addSuggestion(input, file = queueFileFromEnv()) {
  const message = String(input.message || "").trim();
  const replacement = String(input.replacement || "").replace(/\s+$/u, "");

  if (!message) {
    throw new Error("message must be non-empty");
  }

  if (!replacement) {
    throw new Error("replacement must be non-empty");
  }

  if (replacement.length > 10000) {
    throw new Error("replacement is too large");
  }

  return addInlineComment(
    {
      ...input,
      kind: "suggestion",
      body: `${message}\n\n\`\`\`suggestion\n${replacement}\n\`\`\``
    },
    file
  );
}

function hasLine(lines, line) {
  return Array.isArray(lines) && lines.includes(line);
}

function hasEveryLine(lines, startLine, endLine) {
  if (!Array.isArray(lines)) {
    return false;
  }
  const set = new Set(lines);
  for (let line = startLine; line <= endLine; line += 1) {
    if (!set.has(line)) {
      return false;
    }
  }
  return true;
}

function commentKey(comment) {
  return [
    comment.kind,
    comment.path,
    comment.start_line || "",
    comment.line,
    comment.side,
    comment.start_side || "",
    comment.body
  ].join("\0");
}

function replyKey(reply) {
  return [reply.to, reply.body].join("\0");
}

function validateInlineComment(comment, context) {
  try {
    const normalized = normalizeInlineComment(comment);
    const ranges = context.valid_comment_ranges?.[normalized.path];
    if (!ranges) {
      return { ok: false, reason: "path is not present in the PR diff" };
    }

    if (normalized.side !== "RIGHT" || (normalized.start_side && normalized.start_side !== "RIGHT")) {
      return { ok: false, reason: "only RIGHT-side comments are supported" };
    }

    if (!hasLine(ranges.added_lines, normalized.line)) {
      return { ok: false, reason: "line is not an added RIGHT-side line" };
    }

    if (normalized.start_line !== undefined) {
      if (!hasEveryLine(ranges.right_lines, normalized.start_line, normalized.line)) {
        return { ok: false, reason: "multi-line range is not fully present on the RIGHT side of the diff" };
      }
    }

    return { ok: true, comment: normalized };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function validateReply(reply, context) {
  try {
    const normalized = {
      to: positiveInteger(reply.to || reply.comment_id, "to"),
      body: String(reply.body || "").trim()
    };

    if (!normalized.body) {
      return { ok: false, reason: "body must be non-empty" };
    }

    const comments = Array.isArray(context.review_comments) ? context.review_comments : [];
    const target = comments.find((comment) => Number(comment.id) === normalized.to);
    if (!target) {
      return { ok: false, reason: "reply target is not a review comment on this PR" };
    }

    if (target.in_reply_to_id) {
      return { ok: false, reason: "GitHub does not support replies to review-comment replies" };
    }

    return { ok: true, reply: normalized };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function validateQueue(queue, context) {
  const inlineComments = [];
  const replies = [];
  const dropped = [];
  const seenComments = new Set();
  const seenReplies = new Set();

  for (const original of queue.inlineComments || []) {
    const result = validateInlineComment(original, context);
    if (!result.ok) {
      dropped.push({ kind: "inline", item: original, reason: result.reason });
      continue;
    }

    const key = commentKey(result.comment);
    if (seenComments.has(key)) {
      dropped.push({ kind: "inline", item: original, reason: "duplicate queued comment" });
      continue;
    }

    seenComments.add(key);
    inlineComments.push(result.comment);
  }

  for (const original of queue.replies || []) {
    const result = validateReply(original, context);
    if (!result.ok) {
      dropped.push({ kind: "reply", item: original, reason: result.reason });
      continue;
    }

    const key = replyKey(result.reply);
    if (seenReplies.has(key)) {
      dropped.push({ kind: "reply", item: original, reason: "duplicate queued reply" });
      continue;
    }

    seenReplies.add(key);
    replies.push(result.reply);
  }

  return {
    version: 1,
    inlineComments,
    replies,
    dropped,
    stats: {
      queued_inline: (queue.inlineComments || []).length,
      queued_replies: (queue.replies || []).length,
      valid_inline: inlineComments.length,
      valid_replies: replies.length,
      dropped: dropped.length
    }
  };
}

function readContext(file = contextFileFromEnv()) {
  return readJsonFile(file, {
    valid_comment_ranges: {},
    review_comments: []
  });
}

function runGh(args, options = {}) {
  const output = execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.quiet ? "ignore" : "pipe"],
    env: process.env
  });
  return output.trim();
}

function tryGhJson(args, fallback) {
  try {
    const output = runGh(args, { quiet: true });
    return output ? JSON.parse(output) : fallback;
  } catch {
    return fallback;
  }
}

function tryGhPaginatedArray(endpoint) {
  const value = tryGhJson(["api", "--paginate", "--slurp", endpoint], []);
  if (!Array.isArray(value)) {
    return [];
  }

  if (value.every((item) => Array.isArray(item))) {
    return value.flat();
  }

  return value;
}

function readEventContext() {
  const eventName = process.env.GITHUB_EVENT_NAME || null;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const payload = eventPath && fs.existsSync(eventPath) ? readJsonFile(eventPath, {}) : {};
  const triggerComment = payload.comment
    ? {
        id: payload.comment.id,
        user: payload.comment.user?.login || null,
        body: payload.comment.body || "",
        html_url: payload.comment.html_url || null
      }
    : null;

  let reason = "manual";
  if (eventName === "issue_comment") {
    reason = "mention";
  } else if (eventName === "pull_request" && payload.action === "review_requested") {
    reason = "review_requested";
  } else if (eventName === "workflow_dispatch") {
    reason = "workflow_dispatch";
  }

  return {
    event_name: eventName,
    reason,
    actor: process.env.GITHUB_ACTOR || payload.sender?.login || null,
    trigger_comment: triggerComment
  };
}

function detectBotLogin(repo) {
  if (process.env.REVIEW_BOT_LOGIN) {
    return process.env.REVIEW_BOT_LOGIN;
  }

  try {
    const user = tryGhJson(["api", "user"], null);
    return user?.login || null;
  } catch {
    return repo ? "github-actions[bot]" : null;
  }
}

function containsMention(body, botLogin, command) {
  const text = String(body || "").toLowerCase();
  const needles = [command, botLogin ? `@${botLogin}` : null].filter(Boolean).map((value) => value.toLowerCase());
  return needles.some((needle) => text.includes(needle));
}

function buildActionItems({ trigger, issueComments, reviewComments, botLogin, command }) {
  const actionItems = [];

  if (trigger.trigger_comment) {
    actionItems.push({
      id: `issue-comment:${trigger.trigger_comment.id}`,
      kind: "trigger_request",
      actor: trigger.trigger_comment.user,
      body: trigger.trigger_comment.body,
      comment_id: trigger.trigger_comment.id
    });
  }

  for (const comment of issueComments || []) {
    if (containsMention(comment.body, botLogin, command)) {
      actionItems.push({
        id: `issue-comment:${comment.id}`,
        kind: "mentioned",
        actor: comment.user?.login || null,
        body: comment.body || "",
        comment_id: comment.id
      });
    }
  }

  if (botLogin) {
    const byParent = new Map();
    for (const comment of reviewComments || []) {
      const parentId = comment.in_reply_to_id || comment.id;
      if (!byParent.has(parentId)) {
        byParent.set(parentId, []);
      }
      byParent.get(parentId).push(comment);
    }

    for (const [parentId, comments] of byParent.entries()) {
      const topLevel = comments.find((comment) => Number(comment.id) === Number(parentId));
      if (!topLevel || topLevel.user?.login !== botLogin) {
        continue;
      }

      const sorted = comments.slice().sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
      const latest = sorted[sorted.length - 1];
      if (latest && latest.user?.login && latest.user.login !== botLogin) {
        actionItems.push({
          id: `review-comment:${parentId}`,
          kind: "reply_requested",
          actor: latest.user.login,
          body: latest.body || "",
          reply_to_comment_id: Number(parentId),
          latest_reply_id: latest.id
        });
      }
    }
  }

  return actionItems;
}

function buildReviewContext(options = {}) {
  const repo = options.repo || process.env.GITHUB_REPOSITORY;
  const prNumber = options.prNumber || process.env.PR_NUMBER;
  const diffFile = options.diffFile || diffFileFromEnv();

  if (!repo) {
    throw new Error("GITHUB_REPOSITORY is required");
  }

  if (!prNumber) {
    throw new Error("PR_NUMBER is required");
  }

  let diffText;
  if (process.env.PR_DIFF_FILE) {
    diffText = fs.readFileSync(process.env.PR_DIFF_FILE, "utf8");
  } else {
    diffText = runGh(["pr", "diff", String(prNumber), "--repo", repo, "--patch"]);
  }

  fs.writeFileSync(diffFile, diffText);

  const command = process.env.OPENCODE_REVIEW_COMMAND || "@singular-code-review";
  const botLogin = detectBotLogin(repo);
  const trigger = readEventContext();
  const pr = tryGhJson(
    [
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "number,title,body,author,baseRefName,headRefName,headRefOid,baseRefOid,url,isDraft,reviewDecision"
    ],
    { number: Number(prNumber), repository: repo }
  );
  const issueComments = tryGhPaginatedArray(`repos/${repo}/issues/${prNumber}/comments`);
  const reviewComments = tryGhPaginatedArray(`repos/${repo}/pulls/${prNumber}/comments`);
  const reviews = tryGhPaginatedArray(`repos/${repo}/pulls/${prNumber}/reviews`);

  const context = {
    generated_at: new Date().toISOString(),
    run: {
      ...trigger,
      command,
      bot_login: botLogin
    },
    pr,
    diff: {
      file: diffFile,
      files: parseUnifiedDiff(diffText).files.map((file) => file.path)
    },
    valid_comment_ranges: validCommentRangesFromDiff(diffText),
    issue_comments: issueComments,
    review_comments: reviewComments,
    reviews,
    previous_bot_findings: botLogin
      ? reviewComments.filter((comment) => comment.user?.login === botLogin && !comment.in_reply_to_id)
      : [],
    action_items: buildActionItems({
      trigger,
      issueComments,
      reviewComments,
      botLogin,
      command
    })
  };

  return context;
}

module.exports = {
  DEFAULT_CONTEXT_FILE,
  DEFAULT_DIFF_FILE,
  DEFAULT_QUEUE_FILE,
  addInlineComment,
  addReply,
  addSuggestion,
  buildReviewContext,
  clearQueue,
  contextFileFromEnv,
  createEmptyQueue,
  diffFileFromEnv,
  loadQueue,
  normalizeDiffPath,
  parseUnifiedDiff,
  queueFileFromEnv,
  readContext,
  readJsonFile,
  saveQueue,
  validateInlineComment,
  validateQueue,
  validCommentRangesFromDiff,
  writeJsonFile
};
