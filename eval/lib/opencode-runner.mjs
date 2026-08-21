import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function ensureParent(file) {
  mkdirSync(dirname(file), { recursive: true });
}

function writeText(file, value) {
  ensureParent(file);
  writeFileSync(file, value, { mode: 0o600 });
}

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

export function runOpenCodeReview(options) {
  return new Promise((resolveRun) => {
    const startedAt = new Date().toISOString();
    const jobDir = options.jobDir;
    const xdgRoot = options.xdgRoot;
    const configHome = join(xdgRoot, "config");
    const dataHome = join(xdgRoot, "data");
    const cacheHome = join(xdgRoot, "cache");
    const stateHome = join(xdgRoot, "state");
    const rawFile = join(jobDir, "opencode.jsonl");
    const stderrFile = join(jobDir, "stderr.log");
    const reviewFile = join(jobDir, "review.md");
    const prompt = options.prompt;

    mkdirSync(jobDir, { recursive: true });
    mkdirSync(configHome, { recursive: true });
    mkdirSync(dataHome, { recursive: true });
    mkdirSync(cacheHome, { recursive: true });
    mkdirSync(stateHome, { recursive: true });
    writeText(join(configHome, "opencode", "opencode.json"), "{}\n");

    const args = [
      "run",
      "--pure",
      "--model",
      options.model,
      "--format",
      "json",
      "--dir",
      options.workspace,
      "--file",
      options.contextFile,
      "--file",
      options.diffFile,
      "--",
      prompt,
    ];

    let stdout = "";
    let stderr = "";
    let settled = false;
    let sawOutput = false;
    const child = spawn("opencode", args, {
      cwd: options.workspace,
      env: {
        ...process.env,
        HOME: options.home,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_CACHE_HOME: cacheHome,
        XDG_STATE_HOME: stateHome,
        OPENCODE_MODEL: options.model,
        OPENCODE_API_KEY: process.env.OPENCODE_API_KEY || "",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_CLAUDE_CODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(bootTimer);
      clearTimeout(totalTimer);
      const rendered = extractRenderedText(stdout);
      writeText(rawFile, stdout);
      writeText(stderrFile, stderr);
      writeText(reviewFile, rendered ? `${rendered}\n` : "");
      resolveRun({
        ...result,
        startedAt,
        endedAt: new Date().toISOString(),
        args: args.slice(0, -1),
        files: {
          raw: rawFile,
          stderr: stderrFile,
          review: reviewFile,
        },
        outputBytes: Buffer.byteLength(rendered),
      });
    };

    const kill = (reason) => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 5_000).unref();
      finish({ status: 124, error: reason });
    };

    const bootTimer = setTimeout(() => {
      if (!sawOutput) {
        kill(`opencode produced no output within ${options.bootTimeoutMs}ms`);
      }
    }, options.bootTimeoutMs).unref();

    const totalTimer = setTimeout(() => {
      kill(`opencode timed out after ${options.timeoutMs}ms`);
    }, options.timeoutMs).unref();

    child.stdout.on("data", (chunk) => {
      sawOutput = true;
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      sawOutput = true;
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ status: 1, error: error.message });
    });
    child.on("close", (status) => {
      finish({ status: status ?? 1, error: status === 0 ? null : `opencode exited ${status}` });
    });
  });
}

export function cleanupScratch(path, keepScratch) {
  if (!keepScratch) {
    rmSync(path, { recursive: true, force: true });
  }
}
