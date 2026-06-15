import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { findSessionId, textFromJsonEvent } from "../clients/opencode.js";
import { type ArtifactPaths } from "../lib/artifacts.js";
import { readJsonFile, writeJsonFile } from "../lib/json.js";

type JsonRecord = Record<string, unknown>;

export type PhaseUsageStats = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
};

export type ExtractedPhaseStats = {
  name: "gate" | "review" | "audit" | "synthesis";
  outputFile: string;
  jsonOutputFile: string;
  sessionFile: string;
  sessionId: string | null;
  outputBytes: number;
  jsonEvents: number;
  textEvents: number;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  turns: number | null;
  usage: PhaseUsageStats;
};

export type OpenCodeSqliteStats = {
  sqlite3Available: boolean;
  searchedRoots: string[];
  databases: Array<{
    path: string;
    tables: Array<{
      name: string;
      rows: number | null;
      columns: string[];
      numericSummaries: Record<string, { sum: number | null; max: number | null }>;
    }>;
    errors: string[];
  }>;
  errors: string[];
};

export type ReviewStatsExport = {
  generatedAt: string;
  model: string | null;
  repository: string | null;
  prNumber: number | null;
  runtimeDir: string;
  phases: ExtractedPhaseStats[];
  totals: {
    durationMs: number | null;
    turns: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    costUsd: number | null;
    jsonEvents: number;
    textEvents: number;
  };
  opencodeSqlite: OpenCodeSqliteStats;
};

export type ReviewCommentsExport = {
  generatedAt: string;
  gate: GateResultExport | null;
  review: unknown;
  issueComments: unknown[];
  inlineComments: unknown[];
  replies: unknown[];
  dropped: unknown[];
  validationStats: unknown;
};

export type GateResultExport = {
  generatedAt: string | null;
  decision: "answer" | "no-review";
  status: "answered" | "no-review";
  answer: string;
};

export type ReviewExtraction = {
  generatedAt: string;
  transcript: string;
  comments: ReviewCommentsExport;
  stats: ReviewStatsExport;
};

export type WrittenReviewExtraction = {
  transcriptFile: string;
  commentsFile: string;
  statsFile: string;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function readTextFile(file: string): string {
  if (!existsSync(file)) {
    return "";
  }
  return readFileSync(file, "utf8");
}

function readTrimmedFile(file: string): string | null {
  const text = readTextFile(file).trim();
  return text || null;
}

function fileSize(file: string): number {
  try {
    return existsSync(file) ? statSync(file).size : 0;
  } catch {
    return 0;
  }
}

function maxNumber(current: number | null, value: number): number {
  return current === null || value > current ? value : current;
}

function sumNumber(current: number | null, value: number): number {
  return (current || 0) + value;
}

function emptyUsage(): PhaseUsageStats {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
  };
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function isOpenCodeUsageContainer(parentKey: string | null): boolean {
  const normalized = parentKey ? normalizedKey(parentKey) : "";
  return normalized === "tokens" || normalized === "usage";
}

function collectNamedUsage(key: string, item: number, usage: PhaseUsageStats, parentKey: string | null): void {
  const normalized = normalizedKey(key);
  const parentIsUsage = isOpenCodeUsageContainer(parentKey);
  const isInputTokens =
    ((normalized.includes("input") || normalized.includes("prompt")) && normalized.includes("token")) ||
    (parentIsUsage && normalized === "input");
  const isOutputTokens =
    ((normalized.includes("output") || normalized.includes("completion")) && normalized.includes("token")) ||
    (parentIsUsage && normalized === "output");
  const isTotalTokens =
    (normalized.includes("total") && normalized.includes("token")) || (parentIsUsage && normalized === "total");

  if (isInputTokens) {
    usage.inputTokens = maxNumber(usage.inputTokens, item);
  } else if (isOutputTokens) {
    usage.outputTokens = maxNumber(usage.outputTokens, item);
  } else if (isTotalTokens) {
    usage.totalTokens = maxNumber(usage.totalTokens, item);
  } else if (normalized.includes("cost") || normalized.includes("price")) {
    usage.costUsd = maxNumber(usage.costUsd, item);
  }
}

function collectGenericUsage(value: unknown, usage: PhaseUsageStats, parentKey: string | null = null): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectGenericUsage(item, usage, parentKey);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, item] of Object.entries(value as JsonRecord)) {
    if (typeof item === "number" && Number.isFinite(item)) {
      collectNamedUsage(key, item, usage, parentKey);
    }

    collectGenericUsage(item, usage, key);
  }
}

function addUsageSum(target: PhaseUsageStats, source: PhaseUsageStats): void {
  if (source.inputTokens !== null) {
    target.inputTokens = sumNumber(target.inputTokens, source.inputTokens);
  }
  if (source.outputTokens !== null) {
    target.outputTokens = sumNumber(target.outputTokens, source.outputTokens);
  }
  if (source.totalTokens !== null) {
    target.totalTokens = sumNumber(target.totalTokens, source.totalTokens);
  }
  if (source.costUsd !== null) {
    target.costUsd = sumNumber(target.costUsd, source.costUsd);
  }
}

/**
 * OpenCode's JSON stream reports per-step usage under `part.tokens` and
 * `part.cost`. These values are not cumulative, so phase totals sum them.
 */
function openCodeStepUsage(event: unknown): PhaseUsageStats | null {
  const record = asRecord(event);
  const part = asRecord(record.part);
  if (record.type !== "step_finish" && part.type !== "step-finish") {
    return null;
  }

  const tokens = asRecord(part.tokens);
  const usage = emptyUsage();
  if (typeof tokens.input === "number" && Number.isFinite(tokens.input)) {
    usage.inputTokens = tokens.input;
  }
  if (typeof tokens.output === "number" && Number.isFinite(tokens.output)) {
    usage.outputTokens = tokens.output;
  }
  if (typeof tokens.total === "number" && Number.isFinite(tokens.total)) {
    usage.totalTokens = tokens.total;
  }
  if (typeof part.cost === "number" && Number.isFinite(part.cost)) {
    usage.costUsd = part.cost;
  }

  const hasUsage =
    usage.inputTokens !== null ||
    usage.outputTokens !== null ||
    usage.totalTokens !== null ||
    usage.costUsd !== null;
  return hasUsage ? usage : null;
}

function numericTimestamp(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value > 1_000_000_000_000) {
    return value;
  }
  if (value > 1_000_000_000) {
    return value * 1000;
  }
  return null;
}

function collectTimestamps(value: unknown, timestamps: number[], parentKey: string | null = null): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTimestamps(item, timestamps, parentKey);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, item] of Object.entries(value as JsonRecord)) {
    const normalized = key.toLowerCase();
    if (typeof item === "string" && /(?:time|timestamp|created|updated|date)/u.test(normalized)) {
      const parsed = Date.parse(item);
      if (Number.isFinite(parsed)) {
        timestamps.push(parsed);
      }
    } else if (
      typeof item === "number" &&
      (/(?:time|timestamp|created|updated|date)/u.test(normalized) ||
        (parentKey && normalizedKey(parentKey) === "time" && /^(?:start|end)$/u.test(normalized)))
    ) {
      const parsed = numericTimestamp(item);
      if (parsed !== null) {
        timestamps.push(parsed);
      }
    }
    collectTimestamps(item, timestamps, key);
  }
}

function jsonlStats(file: string): Pick<ExtractedPhaseStats, "jsonEvents" | "textEvents" | "startedAt" | "endedAt" | "durationMs" | "turns" | "usage" | "sessionId"> {
  const genericUsage = emptyUsage();
  const stepUsage = emptyUsage();
  let jsonEvents = 0;
  let textEvents = 0;
  let turns = 0;
  let hasStepUsage = false;
  let sessionId: string | null = null;
  const timestamps: number[] = [];

  for (const line of readTextFile(file).split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const event = JSON.parse(line) as unknown;
      jsonEvents += 1;
      sessionId ||= findSessionId(event) || null;
      if (textFromJsonEvent(event)) {
        textEvents += 1;
      }
      if (asRecord(event).type === "step_finish" || asRecord(asRecord(event).part).type === "step-finish") {
        turns += 1;
      }
      const usage = openCodeStepUsage(event);
      if (usage) {
        hasStepUsage = true;
        addUsageSum(stepUsage, usage);
      }
      collectGenericUsage(event, genericUsage);
      collectTimestamps(event, timestamps);
    } catch {
      // Raw stdout warnings can appear in JSONL files when OpenCode falls back
      // or emits non-JSON diagnostics. They are not telemetry events.
    }
  }

  const started = timestamps.length ? Math.min(...timestamps) : null;
  const ended = timestamps.length ? Math.max(...timestamps) : null;
  return {
    jsonEvents,
    textEvents,
    startedAt: started === null ? null : new Date(started).toISOString(),
    endedAt: ended === null ? null : new Date(ended).toISOString(),
    durationMs: started === null || ended === null ? null : Math.max(0, ended - started),
    turns: turns || null,
    usage: hasStepUsage ? stepUsage : genericUsage,
    sessionId,
  };
}

function phaseStats(
  name: ExtractedPhaseStats["name"],
  outputFile: string,
  sessionFile: string,
): ExtractedPhaseStats {
  const jsonOutputFile = `${outputFile}.jsonl`;
  const stats = jsonlStats(jsonOutputFile);
  return {
    name,
    outputFile,
    jsonOutputFile,
    sessionFile,
    sessionId: stats.sessionId || readTrimmedFile(sessionFile),
    outputBytes: fileSize(outputFile),
    jsonEvents: stats.jsonEvents,
    textEvents: stats.textEvents,
    startedAt: stats.startedAt,
    endedAt: stats.endedAt,
    durationMs: stats.durationMs,
    turns: stats.turns,
    usage: stats.usage,
  };
}

function phaseHasActivity(phase: ExtractedPhaseStats): boolean {
  return Boolean(phase.sessionId) || phase.outputBytes > 0 || phase.jsonEvents > 0 || phase.textEvents > 0;
}

function sumNullable(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => typeof value === "number");
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null;
}

function sqliteCommandAvailable(): boolean {
  const result = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

function sqliteRoots(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || "/root";
  return Array.from(
    new Set(
      [
        env.XDG_STATE_HOME && join(env.XDG_STATE_HOME, "opencode"),
        env.XDG_DATA_HOME && join(env.XDG_DATA_HOME, "opencode"),
        env.XDG_CACHE_HOME && join(env.XDG_CACHE_HOME, "opencode"),
        env.XDG_CONFIG_HOME && join(env.XDG_CONFIG_HOME, "opencode"),
        join(home, ".local", "state", "opencode"),
        join(home, ".local", "share", "opencode"),
        join(home, ".cache", "opencode"),
        join(home, ".config", "opencode"),
      ].filter((value): value is string => Boolean(value)),
    ),
  );
}

function isSqliteFile(file: string): boolean {
  const extension = extname(file).toLowerCase();
  if (extension === ".db" || extension === ".sqlite" || extension === ".sqlite3") {
    return true;
  }

  try {
    const fd = openSync(file, "r");
    const buffer = Buffer.alloc(16);
    try {
      readSync(fd, buffer, 0, 16, 0);
      return buffer.toString("utf8") === "SQLite format 3";
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function findSqliteFiles(root: string, depth = 0): string[] {
  if (depth > 8 || !existsSync(root)) {
    return [];
  }

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...findSqliteFiles(file, depth + 1));
    } else if (entry.isFile() && isSqliteFile(file)) {
      files.push(file);
    }
  }
  return files;
}

function sqliteJson(file: string, sql: string): JsonRecord[] {
  const result = spawnSync("sqlite3", ["-readonly", "-json", file, sql], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `sqlite3 exited ${result.status}`).trim());
  }

  const stdout = result.stdout.trim();
  return stdout ? (JSON.parse(stdout) as JsonRecord[]) : [];
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

function numericColumnSummary(file: string, table: string, column: string): { sum: number | null; max: number | null } {
  const tableName = quoteIdentifier(table);
  const columnName = quoteIdentifier(column);
  const rows = sqliteJson(
    file,
    `select sum(case when typeof(${columnName}) in ('integer','real') then ${columnName} else null end) as sum, max(case when typeof(${columnName}) in ('integer','real') then ${columnName} else null end) as max from ${tableName}`,
  );
  const row = rows[0] || {};
  return {
    sum: typeof row.sum === "number" ? row.sum : null,
    max: typeof row.max === "number" ? row.max : null,
  };
}

function inspectSqliteDatabase(file: string): OpenCodeSqliteStats["databases"][number] {
  const errors: string[] = [];
  const tables: OpenCodeSqliteStats["databases"][number]["tables"] = [];

  try {
    const schema = sqliteJson(
      file,
      "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name",
    );

    for (const item of schema) {
      const name = typeof item.name === "string" ? item.name : "";
      if (!name) {
        continue;
      }

      try {
        const tableName = quoteIdentifier(name);
        const rowCount = sqliteJson(file, `select count(*) as rows from ${tableName}`)[0]?.rows;
        const columns = sqliteJson(file, `pragma table_info(${tableName})`)
          .map((column) => (typeof column.name === "string" ? column.name : ""))
          .filter(Boolean);
        const interestingColumns = columns.filter((column) =>
          /token|cost|price|duration|elapsed|turn|message|session/iu.test(column),
        );
        const numericSummaries = Object.fromEntries(
          interestingColumns.map((column) => [column, numericColumnSummary(file, name, column)]),
        );

        tables.push({
          name,
          rows: typeof rowCount === "number" ? rowCount : null,
          columns,
          numericSummaries,
        });
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return { path: file, tables, errors };
}

export function extractOpenCodeSqliteStats(env: NodeJS.ProcessEnv = process.env): OpenCodeSqliteStats {
  const searchedRoots = sqliteRoots(env);
  const sqlite3Available = sqliteCommandAvailable();
  const files = Array.from(new Set(searchedRoots.flatMap((root) => findSqliteFiles(root)))).sort();

  if (!sqlite3Available) {
    return {
      sqlite3Available,
      searchedRoots,
      databases: files.map((file) => ({ path: file, tables: [], errors: ["sqlite3 command not available"] })),
      errors: files.length ? ["sqlite3 command not available"] : [],
    };
  }

  return {
    sqlite3Available,
    searchedRoots,
    databases: files.map(inspectSqliteDatabase),
    errors: [],
  };
}

function reviewCommentsExport(paths: ArtifactPaths, generatedAt: string): ReviewCommentsExport {
  const gate = gateResultExport(paths);
  if (gate) {
    return {
      generatedAt,
      gate,
      review: {},
      issueComments: [
        {
          source: "gate",
          decision: gate.decision,
          body: gate.answer,
        },
      ],
      inlineComments: [],
      replies: [],
      dropped: [],
      validationStats: null,
    };
  }

  const payload = readJsonFile<unknown>(paths.payloadFile, {});
  const validated = asRecord(readJsonFile<unknown>(paths.validatedFile, {}));
  const payloadRecord = asRecord(payload);

  return {
    generatedAt,
    gate: null,
    review: payload,
    issueComments: [],
    inlineComments: Array.isArray(payloadRecord.comments) ? payloadRecord.comments : [],
    replies: Array.isArray(validated.replies) ? validated.replies : [],
    dropped: Array.isArray(validated.dropped) ? validated.dropped : [],
    validationStats: validated.stats || null,
  };
}

function gateResultExport(paths: ArtifactPaths): GateResultExport | null {
  const result = asRecord(readJsonFile<unknown>(paths.gateResultFile, {}));
  const decision = result.decision;
  const status = result.status;
  const answer = stringValue(result.answer);

  if ((decision !== "answer" && decision !== "no-review") || (status !== "answered" && status !== "no-review") || !answer) {
    return null;
  }

  return {
    generatedAt: stringValue(result.generated_at),
    decision,
    status,
    answer,
  };
}

function renderCommentList(items: unknown[], emptyText: string): string {
  if (items.length === 0) {
    return `${emptyText}\n`;
  }

  return items
    .map((item, index) => {
      const record = asRecord(item);
      const location = [record.path, record.line].filter(Boolean).join(":");
      const heading = location ? `${index + 1}. ${location}` : `${index + 1}.`;
      return `${heading}\n\n${String(record.body || "").trim() || JSON.stringify(item, null, 2)}`;
    })
    .join("\n\n");
}

function renderGateResult(gate: GateResultExport | null): string {
  if (!gate) {
    return "_No gate-only outcome was recorded._";
  }

  return `Decision: ${gate.decision}\nStatus: ${gate.status}\n\n${gate.answer}`;
}

function reviewBody(comments: ReviewCommentsExport): string {
  return String(asRecord(comments.review).body || "").trim();
}

function renderTranscript(options: {
  generatedAt: string;
  model: string | null;
  repository: string | null;
  prNumber: number | null;
  comments: ReviewCommentsExport;
  paths: ArtifactPaths;
}): string {
  const body = reviewBody(options.comments) || "_No review body was produced._";

  return `# Singular Code Review Transcript

- Generated: ${options.generatedAt}
- Repository: ${options.repository || "unknown"}
- Pull request: ${options.prNumber || "unknown"}
- Model: ${options.model || "unknown"}

## Final Review Body

${body}

## Gate Decision

${renderGateResult(options.comments.gate)}

## Issue Comments

${renderCommentList(options.comments.issueComments, "_No issue comments would be posted._")}

## Inline Comments

${renderCommentList(options.comments.inlineComments, "_No inline comments would be posted._")}

## Replies

${renderCommentList(options.comments.replies, "_No replies would be posted._")}

## Gate Output

\`\`\`text
${readTextFile(options.paths.gateOutputFile).trim()}
\`\`\`

## Reviewer Output

\`\`\`text
${readTextFile(options.paths.reviewOutputFile).trim()}
\`\`\`

## Audit Output

\`\`\`text
${readTextFile(options.paths.auditOutputFile).trim()}
\`\`\`

## Synthesis Output

\`\`\`text
${readTextFile(options.paths.synthesisOutputFile).trim()}
\`\`\`
`;
}

function statsExport(options: {
  generatedAt: string;
  model: string | null;
  repository: string | null;
  prNumber: number | null;
  paths: ArtifactPaths;
  env: NodeJS.ProcessEnv;
}): ReviewStatsExport {
  const gatePhase = phaseStats("gate", options.paths.gateOutputFile, options.paths.gateSessionFile);
  const gateResult = gateResultExport(options.paths);
  const reviewPhases = [
    phaseStats("review", options.paths.reviewOutputFile, options.paths.reviewSessionFile),
    phaseStats("audit", options.paths.auditOutputFile, options.paths.auditorSessionFile),
    phaseStats("synthesis", options.paths.synthesisOutputFile, options.paths.auditorSessionFile),
  ];
  const phases = [
    ...(phaseHasActivity(gatePhase) ? [gatePhase] : []),
    ...(gateResult ? [] : reviewPhases),
  ];

  return {
    generatedAt: options.generatedAt,
    model: options.model,
    repository: options.repository,
    prNumber: options.prNumber,
    runtimeDir: options.paths.runtimeDir,
    phases,
    totals: {
      durationMs: sumNullable(phases.map((phase) => phase.durationMs)),
      turns: sumNullable(phases.map((phase) => phase.turns)),
      inputTokens: sumNullable(phases.map((phase) => phase.usage.inputTokens)),
      outputTokens: sumNullable(phases.map((phase) => phase.usage.outputTokens)),
      totalTokens: sumNullable(phases.map((phase) => phase.usage.totalTokens)),
      costUsd: sumNullable(phases.map((phase) => phase.usage.costUsd)),
      jsonEvents: phases.reduce((sum, phase) => sum + phase.jsonEvents, 0),
      textEvents: phases.reduce((sum, phase) => sum + phase.textEvents, 0),
    },
    opencodeSqlite: extractOpenCodeSqliteStats(options.env),
  };
}

export function extractReviewArtifacts(options: {
  paths: ArtifactPaths;
  env?: NodeJS.ProcessEnv;
  generatedAt?: string;
}): ReviewExtraction {
  const env = options.env || process.env;
  const generatedAt = options.generatedAt || new Date().toISOString();
  const model = env.OPENCODE_MODEL || null;
  const repository = env.GITHUB_REPOSITORY || null;
  const prNumber = env.PR_NUMBER ? Number(env.PR_NUMBER) : null;
  const comments = reviewCommentsExport(options.paths, generatedAt);
  const stats = statsExport({
    generatedAt,
    model,
    repository,
    prNumber: Number.isFinite(prNumber) ? prNumber : null,
    paths: options.paths,
    env,
  });

  return {
    generatedAt,
    comments,
    stats,
    transcript: renderTranscript({
      generatedAt,
      model,
      repository,
      prNumber: Number.isFinite(prNumber) ? prNumber : null,
      comments,
      paths: options.paths,
    }),
  };
}

export function writeReviewExtraction(
  extraction: ReviewExtraction,
  paths: Pick<ArtifactPaths, "transcriptFile" | "commentsFile" | "statsFile">,
): WrittenReviewExtraction {
  mkdirSync(dirname(paths.transcriptFile), { recursive: true });
  writeFileSync(paths.transcriptFile, extraction.transcript, { mode: 0o600 });
  writeJsonFile(paths.commentsFile, extraction.comments);
  writeJsonFile(paths.statsFile, extraction.stats);

  return {
    transcriptFile: paths.transcriptFile,
    commentsFile: paths.commentsFile,
    statsFile: paths.statsFile,
  };
}

function formatNullable(value: number | null, suffix = ""): string {
  return typeof value === "number" ? `${value}${suffix}` : "n/a";
}

function tableCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>");
}

function truncateSummary(value: string, maxLength = 320): string {
  const compact = value.trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1).trimEnd()}...`;
}

function formatDurationSeconds(value: number | null): string {
  return typeof value === "number" ? `${(value / 1000).toFixed(1)} s` : "n/a";
}

function formatCostUsd(value: number | null): string {
  return typeof value === "number" ? `$${value.toFixed(4)}` : "n/a";
}

function renderPhaseSummary(phases: ExtractedPhaseStats[]): string {
  if (phases.length === 0) {
    return "_No OpenCode phase telemetry was recorded._";
  }

  const rows = phases
    .map(
      (phase) =>
        `| ${phase.name} | ${phase.sessionId || "n/a"} | ${formatDurationSeconds(phase.durationMs)} | ${formatNullable(phase.turns)} | ${formatNullable(phase.usage.inputTokens)} | ${formatNullable(phase.usage.outputTokens)} | ${formatNullable(phase.usage.totalTokens)} | ${formatCostUsd(phase.usage.costUsd)} | ${phase.jsonEvents}/${phase.textEvents} |`,
    )
    .join("\n");

  return `| Phase | Session | Duration | Turns | Input | Output | Total | Cost | Events JSON/Text |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}`;
}

function gateSummaryRows(gate: GateResultExport | null): string {
  if (!gate) {
    return "";
  }

  const outcome = gate.status === "answered" ? "Answered user question; full review not run" : "No full re-review needed";
  return [
    `| Gate outcome | ${tableCell(outcome)} |`,
    `| Gate decision | ${tableCell(gate.decision)} |`,
    `| Gate comment | ${tableCell(truncateSummary(gate.answer))} |`,
  ].join("\n");
}

export function renderGitHubStepSummary(extraction: ReviewExtraction): string {
  const stats = extraction.stats;
  const comments = extraction.comments;
  const sqliteDatabases = stats.opencodeSqlite.databases.length;
  const gateRows = gateSummaryRows(comments.gate);

  return `# Singular Code Review Telemetry

| Metric | Value |
| --- | --- |
| Model | ${stats.model || "unknown"} |
| Repository | ${stats.repository || "unknown"} |
| Pull request | ${stats.prNumber || "unknown"} |
${gateRows ? `${gateRows}\n` : ""}| Duration | ${formatDurationSeconds(stats.totals.durationMs)} |
| Turns | ${formatNullable(stats.totals.turns)} |
| Input tokens | ${formatNullable(stats.totals.inputTokens)} |
| Output tokens | ${formatNullable(stats.totals.outputTokens)} |
| Total tokens | ${formatNullable(stats.totals.totalTokens)} |
| Cost | ${formatCostUsd(stats.totals.costUsd)} |
| OpenCode JSON events | ${stats.totals.jsonEvents} |
| OpenCode text events | ${stats.totals.textEvents} |
| SQLite databases inspected | ${sqliteDatabases} |
| Issue comments | ${comments.issueComments.length} |
| Inline comments | ${comments.inlineComments.length} |
| Replies | ${comments.replies.length} |
| Dropped comments | ${comments.dropped.length} |

## Phase Telemetry

${renderPhaseSummary(stats.phases)}
`;
}

export function outputPaths(base: ArtifactPaths, outDir?: string): Pick<ArtifactPaths, "transcriptFile" | "commentsFile" | "statsFile"> {
  if (!outDir) {
    return {
      transcriptFile: base.transcriptFile,
      commentsFile: base.commentsFile,
      statsFile: base.statsFile,
    };
  }

  return {
    transcriptFile: join(outDir, "review_transcript.md"),
    commentsFile: join(outDir, "review_comments.json"),
    statsFile: join(outDir, "review_stats.json"),
  };
}
