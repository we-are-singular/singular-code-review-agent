const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function defaultRuntimeDir() {
  const gitDir = path.join(process.cwd(), ".git");
  if (fs.existsSync(gitDir)) {
    return path.join(gitDir, "singular-code-review");
  }
  return path.join(os.tmpdir(), "singular-code-review");
}

function defaultQueueFile() {
  return path.join(defaultRuntimeDir(), "review_queue.json");
}

function defaultContextFile() {
  return path.join(defaultRuntimeDir(), "review_context.json");
}

function defaultDiffFile() {
  return path.join(defaultRuntimeDir(), "pr.diff");
}

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
    conclusion: null,
    dropped: [],
    updatedAt: new Date().toISOString()
  };
}

function queueFileFromEnv() {
  return process.env.REVIEW_QUEUE_FILE || process.env.REVIEW_STAGED_FILE || defaultQueueFile();
}

function contextFileFromEnv() {
  return process.env.REVIEW_CONTEXT_FILE || defaultContextFile();
}

function diffFileFromEnv() {
  return process.env.REVIEW_DIFF_FILE || defaultDiffFile();
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
    conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
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

function setConclusion(input, file = queueFileFromEnv()) {
  const body = String(input.body || input.conclusion || "").trim();
  if (!body) {
    throw new Error("body must be non-empty");
  }

  if (body.length > 10000) {
    throw new Error("body is too large");
  }

  const queue = loadQueue(file);
  queue.conclusion = body;
  saveQueue(queue, file);
  return { body };
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

function commentLocationKey(comment) {
  return [
    comment.path,
    comment.start_line || "",
    comment.line,
    comment.side,
    comment.start_side || ""
  ].join("\0");
}

function normalizeComparableBody(body) {
  return String(body || "")
    .replace(/\s+/g, " ")
    .trim();
}

function replyKey(reply) {
  return [reply.to, reply.body].join("\0");
}

function commentFromThread(thread) {
  const comments = Array.isArray(thread?.comments) ? thread.comments : [];
  const topLevel = comments[0] || null;
  const pathValue = thread?.path || topLevel?.path;
  const lineValue = thread?.line || topLevel?.line;

  if (!pathValue || !lineValue) {
    return null;
  }

  const comment = {
    kind: "comment",
    path: pathValue,
    line: Number(lineValue),
    side: thread?.side || thread?.diff_side || topLevel?.side || topLevel?.diff_side || "RIGHT",
    body: topLevel?.body || ""
  };

  const startLine = thread?.start_line || thread?.startLine || topLevel?.start_line || topLevel?.startLine;
  if (startLine && Number(startLine) !== Number(lineValue)) {
    comment.start_line = Number(startLine);
    comment.start_side =
      thread?.start_side || thread?.startDiffSide || topLevel?.start_side || topLevel?.startDiffSide || "RIGHT";
  }

  return comment;
}

function existingBotFindingMatches(context) {
  const botLogin = context.run?.bot_login;
  const matches = {
    unresolvedBodyKeys: new Set(),
    restBodyKeys: new Set()
  };

  if (!botLogin) {
    return matches;
  }

  if (context.review_threads_available) {
    for (const thread of context.unresolved_bot_threads || []) {
      const comment = commentFromThread(thread);
      if (!comment) {
        continue;
      }
      matches.unresolvedBodyKeys.add(`${commentLocationKey(comment)}\0${normalizeComparableBody(comment.body)}`);
    }
    return matches;
  }

  for (const comment of context.review_comments || []) {
    if (comment.user?.login !== botLogin || comment.in_reply_to_id) {
      continue;
    }

    const comparable = {
      kind: "comment",
      path: comment.path,
      line: Number(comment.line),
      side: comment.side || "RIGHT",
      body: comment.body || ""
    };
    const startLine = comment.start_line || comment.startLine;
    if (startLine && Number(startLine) !== Number(comment.line)) {
      comparable.start_line = Number(startLine);
      comparable.start_side = comment.start_side || comment.startSide || "RIGHT";
    }

    matches.restBodyKeys.add(`${commentLocationKey(comparable)}\0${normalizeComparableBody(comparable.body)}`);
  }

  return matches;
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
  const existingBotMatches = existingBotFindingMatches(context);

  for (const original of queue.inlineComments || []) {
    const result = validateInlineComment(original, context);
    if (!result.ok) {
      dropped.push({ kind: "inline", item: original, reason: result.reason });
      continue;
    }

    const locationKey = commentLocationKey(result.comment);
    const bodyKey = `${locationKey}\0${normalizeComparableBody(result.comment.body)}`;
    if (existingBotMatches.unresolvedBodyKeys.has(bodyKey)) {
      dropped.push({ kind: "inline", item: original, reason: "matching unresolved bot thread already exists" });
      continue;
    }

    if (existingBotMatches.restBodyKeys.has(bodyKey)) {
      dropped.push({ kind: "inline", item: original, reason: "matching previous bot comment already exists" });
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
      has_conclusion: Boolean(queue.conclusion),
      valid_inline: inlineComments.length,
      valid_replies: replies.length,
      dropped: dropped.length
    },
    conclusion: typeof queue.conclusion === "string" && queue.conclusion.trim() ? queue.conclusion.trim() : null
  };
}

function readContext(file = contextFileFromEnv()) {
  return readJsonFile(file, {
    valid_comment_ranges: {},
    review_comments: [],
    review_threads_available: false,
    review_threads: [],
    unresolved_review_threads: [],
    unresolved_bot_threads: []
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

function splitRepository(repo) {
  const [owner, name] = String(repo || "").split("/", 2);
  if (!owner || !name) {
    throw new Error("GITHUB_REPOSITORY must use owner/name format");
  }
  return { owner, name };
}

function normalizeReviewThread(node) {
  const comments = (node.comments?.nodes || []).map((comment) => ({
    id: comment.databaseId || null,
    node_id: comment.id || null,
    user: {
      login: comment.author?.login || null
    },
    body: comment.body || "",
    path: comment.path || node.path || null,
    line: comment.line || node.line || null,
    start_line: comment.startLine || node.startLine || null,
    side: comment.diffSide || node.diffSide || "RIGHT",
    start_side: comment.startDiffSide || node.startDiffSide || null,
    created_at: comment.createdAt || null,
    html_url: comment.url || null
  }));
  const firstComment = comments[0] || null;
  const latestComment = comments[comments.length - 1] || null;

  return {
    id: node.id || null,
    is_resolved: Boolean(node.isResolved),
    is_outdated: Boolean(node.isOutdated),
    path: node.path || firstComment?.path || null,
    line: node.line || firstComment?.line || null,
    start_line: node.startLine || firstComment?.start_line || null,
    side: node.diffSide || firstComment?.side || "RIGHT",
    start_side: node.startDiffSide || firstComment?.start_side || null,
    top_level_comment_id: firstComment?.id || null,
    top_level_author: firstComment?.user?.login || null,
    latest_author: latestComment?.user?.login || null,
    latest_comment_id: latestComment?.id || null,
    comments
  };
}

function tryFetchReviewThreads(repo, prNumber) {
  const { owner, name } = splitRepository(repo);
  const query = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          diffSide
          startDiffSide
          comments(first: 100) {
            nodes {
              databaseId
              id
              body
              path
              line
              startLine
              diffSide
              startDiffSide
              createdAt
              url
              author {
                login
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

  const threads = [];
  let cursor = null;

  try {
    for (;;) {
      const args = [
        "api",
        "graphql",
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${Number(prNumber)}`,
        "-f",
        `query=${query}`
      ];
      if (cursor) {
        args.push("-f", `cursor=${cursor}`);
      }

      const response = JSON.parse(runGh(args, { quiet: true }) || "{}");
      const connection = response.data?.repository?.pullRequest?.reviewThreads;
      if (!connection || !Array.isArray(connection.nodes)) {
        return { available: false, threads: [] };
      }

      threads.push(...connection.nodes.map(normalizeReviewThread));
      if (!connection.pageInfo?.hasNextPage) {
        return { available: true, threads };
      }

      cursor = connection.pageInfo.endCursor;
      if (!cursor) {
        return { available: true, threads };
      }
    }
  } catch {
    return { available: false, threads: [] };
  }
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

function buildActionItems({ trigger, issueComments, reviewComments, reviewThreads, reviewThreadsAvailable, botLogin, command }) {
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

  if (botLogin && reviewThreadsAvailable) {
    for (const thread of reviewThreads || []) {
      if (thread.is_resolved || thread.top_level_author !== botLogin || thread.latest_author === botLogin) {
        continue;
      }

      if (thread.top_level_comment_id) {
        actionItems.push({
          id: `review-thread:${thread.id}`,
          kind: "reply_requested",
          actor: thread.latest_author,
          body: thread.comments[thread.comments.length - 1]?.body || "",
          reply_to_comment_id: Number(thread.top_level_comment_id),
          latest_reply_id: thread.latest_comment_id,
          review_thread_id: thread.id,
          path: thread.path,
          line: thread.line
        });
      }
    }
  } else if (botLogin) {
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

  const command = "@singular-code-review";
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
  const reviewThreadsResult = tryFetchReviewThreads(repo, prNumber);
  const reviewThreads = reviewThreadsResult.threads;
  const unresolvedReviewThreads = reviewThreads.filter((thread) => !thread.is_resolved);
  const unresolvedBotThreads = botLogin
    ? unresolvedReviewThreads.filter((thread) => thread.top_level_author === botLogin)
    : [];

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
    review_threads_available: reviewThreadsResult.available,
    review_threads: reviewThreads,
    unresolved_review_threads: unresolvedReviewThreads,
    unresolved_bot_threads: unresolvedBotThreads,
    reviews,
    previous_bot_findings: botLogin
      ? reviewComments.filter((comment) => comment.user?.login === botLogin && !comment.in_reply_to_id)
      : [],
    action_items: buildActionItems({
      trigger,
      issueComments,
      reviewComments,
      reviewThreads,
      reviewThreadsAvailable: reviewThreadsResult.available,
      botLogin,
      command
    })
  };

  return context;
}

module.exports = {
  addInlineComment,
  addReply,
  addSuggestion,
  setConclusion,
  buildReviewContext,
  clearQueue,
  contextFileFromEnv,
  createEmptyQueue,
  defaultContextFile,
  defaultDiffFile,
  defaultQueueFile,
  defaultRuntimeDir,
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
