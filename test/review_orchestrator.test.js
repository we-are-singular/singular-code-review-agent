const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const orchestrator = path.join(repoRoot, "bin", "review_orchestrator.sh");
const fixture = path.join(repoRoot, "test", "fixtures", "sample.patch");

function makeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function makeHarness(opencodeBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-"));
  const workspace = path.join(dir, "workspace");
  const mockbin = path.join(dir, "mockbin");
  fs.mkdirSync(workspace);
  fs.mkdirSync(mockbin);

  const apiPayloadFile = path.join(dir, "api-payload.json");

  makeExecutable(
    path.join(mockbin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "pr" && "\${2:-}" == "diff" ]]; then
  cat "${fixture}"
  exit 0
fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "view" ]]; then
  printf '{"number":42,"title":"Test PR","body":"Body","author":{"login":"alice"},"baseRefName":"main","headRefName":"feature","url":"https://github.com/owner/repo/pull/42"}\\n'
  exit 0
fi
if [[ "\${1:-}" == "api" ]]; then
  if [[ "\${2:-}" == "user" ]]; then
    printf '{"login":"review-bot"}\\n'
    exit 0
  fi
  if [[ "\${2:-}" == "graphql" ]]; then
    printf '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}\\n'
    exit 0
  fi
  if [[ " $* " == *" --paginate "* ]]; then
    for arg in "$@"; do
      case "$arg" in
        repos/owner/repo/issues/42/comments)
          printf '[]\\n'
          exit 0
          ;;
        repos/owner/repo/pulls/42/comments)
          printf '[{"id":456,"body":"Existing finding","user":{"login":"review-bot"},"path":"src/app.js","line":2}]\\n'
          exit 0
          ;;
        repos/owner/repo/pulls/42/reviews)
          printf '[]\\n'
          exit 0
          ;;
      esac
    done
  fi
  input=""
  endpoint=""
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == "--input" ]]; then
      input="$2"
      shift 2
    elif [[ "$1" == repos/* ]]; then
      endpoint="$1"
      shift
    else
      shift
    fi
  done
  if [[ "$endpoint" == "repos/owner/repo/pulls/42/reviews" ]]; then
    cp "$input" "${apiPayloadFile}"
    exit 0
  fi
  if [[ "$endpoint" == "repos/owner/repo/pulls/42/comments/456/replies" ]]; then
    cp "$input" "${apiPayloadFile}.reply"
    exit 0
  fi
  echo "unexpected gh api endpoint: $endpoint" >&2
  exit 1
fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "checkout" ]]; then
  exit 0
fi
echo "unexpected gh invocation: $*" >&2
exit 1
`
  );

  makeExecutable(path.join(mockbin, "opencode"), opencodeBody);
  makeExecutable(path.join(mockbin, "context7-mcp"), `#!/usr/bin/env bash
echo "context7 mock"
`);

  return { dir, workspace, mockbin, apiPayloadFile };
}

function runOrchestrator(harness, overrides = {}, options = {}) {
  const reviewFileEnv = options.useDefaultReviewFiles
    ? {}
    : {
        REVIEW_QUEUE_FILE: path.join(harness.dir, "review_queue.json"),
        REVIEW_CONTEXT_FILE: path.join(harness.dir, "review_context.json"),
        REVIEW_DIFF_FILE: path.join(harness.dir, "pr.diff"),
        REVIEW_VALIDATED_FILE: path.join(harness.dir, "review_validated.json"),
        REVIEW_PAYLOAD_FILE: path.join(harness.dir, "final_review.json")
      };
  const env = {
    ...process.env,
    PATH: `${harness.mockbin}:${path.join(repoRoot, "bin")}:${process.env.PATH}`,
    WORKSPACE: harness.workspace,
    PR_NUMBER: "42",
    GITHUB_REPOSITORY: "owner/repo",
    GH_TOKEN: "test-token",
    HOME: path.join(harness.dir, "home"),
    ...reviewFileEnv,
    ...overrides
  };

  return execFileSync("bash", [orchestrator], {
    cwd: harness.workspace,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

test("submits a single batched review with only valid comments", () => {
  const harness = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "run" && "\${2:-}" == "--help" ]]; then
  exit 1
fi
if [[ "$*" == *"Audit the queued pull request review comments"* ]]; then
  printf 'Audit complete.\n'
  exit 0
fi
if [[ "$*" == *"Reviewer terminal output"* ]]; then
  [[ "$*" == *"Final validated review queue"* ]] || exit 3
  printf 'Synthesized conclusion: one blocking finding.\n'
  exit 0
fi
review_comments add --path "src/app.js" --line "2" --body "The new timeout can become NaN and break callers."
review_comments add --path "src/app.js" --line "1" --body "This context-line comment should be filtered."
review_comments add --path "src/app.js" --line "2" --body "The new timeout can become NaN and break callers."
`);

  runOrchestrator(harness);

  const payload = JSON.parse(fs.readFileSync(harness.apiPayloadFile, "utf8"));
  assert.equal(payload.event, "COMMENT");
  assert.equal(payload.body, "Synthesized conclusion: one blocking finding.");
  assert.equal(payload.comments.length, 1);
  assert.deepEqual(payload.comments[0], {
    path: "src/app.js",
    line: 2,
    side: "RIGHT",
    body: "The new timeout can become NaN and break callers."
  });
});

test("audits the queued review file before submission", () => {
  const harness = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "run" && "\${2:-}" == "--help" ]]; then
  exit 1
fi
if [[ "$*" == *"Audit the queued pull request review comments"* ]]; then
  node -e '
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, "utf8"));
if (config.mcp) process.exit(2);
const queue = JSON.parse(fs.readFileSync(process.env.REVIEW_QUEUE_FILE, "utf8"));
queue.inlineComments = [
  {
    kind: "comment",
    path: "src/app.js",
    line: 2,
    side: "RIGHT",
    body: "The timeout can become NaN and break callers; validate or default it before use."
  }
];
fs.writeFileSync(process.env.REVIEW_QUEUE_FILE, JSON.stringify(queue, null, 2) + "\\n");
'
  printf 'Audit complete.\n'
  exit 0
fi
if [[ "$*" == *"Reviewer terminal output"* ]]; then
  [[ "$*" == *"Final validated review queue"* ]] || exit 3
  printf 'Synthesized conclusion: audited finding.\n'
  exit 0
fi
review_comments add --path "src/app.js" --line "2" --body "The timeout can become NaN."
review_comments add --path "src/app.js" --line "2" --body "This breaks callers when the timeout is NaN."
`);

  runOrchestrator(harness);

  const payload = JSON.parse(fs.readFileSync(harness.apiPayloadFile, "utf8"));
  assert.equal(payload.body, "Synthesized conclusion: audited finding.");
  assert.deepEqual(payload.comments, [
    {
      path: "src/app.js",
      line: 2,
      side: "RIGHT",
      body: "The timeout can become NaN and break callers; validate or default it before use."
    }
  ]);
});

test("synthesizes a fallback conclusion with OpenCode when no valid review content remains", () => {
  const harness = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "run" && "\${2:-}" == "--help" ]]; then
  exit 1
fi
count_file="$OPENCODE_INVOCATION_COUNT_FILE"
count=0
if [[ -f "$count_file" ]]; then
  count="$(cat "$count_file")"
fi
count=$((count + 1))
printf '%s' "$count" > "$count_file"
if [[ "$count" -eq 1 ]]; then
  review_comments add --path "src/app.js" --line "1" --body "Context-line comment should be filtered."
  printf 'Reviewer summary from stdout.\n'
  exit 0
fi
if [[ "$*" == *"Audit the queued pull request review comments"* ]]; then
  printf 'Audit complete.\n'
  exit 0
fi
printf 'Polished synthesis: the PR only removes a blank line and has no blocking findings.\n'
`);
  const countFile = path.join(harness.dir, "opencode-count");

  runOrchestrator(harness, {
    OPENCODE_INVOCATION_COUNT_FILE: countFile
  });

  const payload = JSON.parse(fs.readFileSync(harness.apiPayloadFile, "utf8"));
  assert.equal(payload.event, "COMMENT");
  assert.equal(
    payload.body,
    "Polished synthesis: the PR only removes a blank line and has no blocking findings."
  );
  assert.deepEqual(payload.comments, []);
  assert.equal(fs.readFileSync(countFile, "utf8"), "3");
});



test("submits a conclusion-only review when there are no inline findings", () => {
  const harness = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "run" && "\${2:-}" == "--help" ]]; then
  exit 1
fi
if [[ "$*" == *"Reviewer terminal output"* ]]; then
  printf '> reviewer · minimax-m2.7\n\n> reviewer · minimax-m2.7\nLGTM — no blocking findings.\n'
  exit 0
fi
printf 'No blocking findings.\n'
`);

  runOrchestrator(harness);

  const payload = JSON.parse(fs.readFileSync(harness.apiPayloadFile, "utf8"));
  assert.equal(payload.event, "COMMENT");
  assert.equal(payload.body, "> reviewer · minimax-m2.7\n\nLGTM — no blocking findings.");
  assert.deepEqual(payload.comments, []);
});

test("installs the committed OpenCode config template", () => {
  const harness = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "run" && "\${2:-}" == "--help" ]]; then
  exit 1
fi
`);

  runOrchestrator(harness, {
    OPENCODE_MODEL: "test/model",
    CONTEXT7_API_KEY: "ctx7-test"
  });

  const config = JSON.parse(
    fs.readFileSync(path.join(harness.dir, "home", ".config", "opencode", "opencode.json"), "utf8")
  );

  assert.equal(config.model, "{env:OPENCODE_MODEL}");
  assert.equal(config.default_agent, "reviewer");
  assert.deepEqual(config.permission, {
    edit: {
      "*": "deny",
      ".git/singular-code-review/review_queue.json": "allow",
      "**/.git/singular-code-review/review_queue.json": "allow",
      "/**/.git/singular-code-review/review_queue.json": "allow"
    },
    bash: "allow",
    webfetch: "allow"
  });
  assert.deepEqual(config.agent.reviewer, {
    description: "Reviews pull requests and queues structured GitHub review feedback.",
    mode: "primary",
    model: "{env:OPENCODE_MODEL}",
    prompt: "{file:./AGENTS.md}",
    permission: {
      edit: {
        "*": "deny",
        ".git/singular-code-review/review_queue.json": "allow",
        "**/.git/singular-code-review/review_queue.json": "allow",
        "/**/.git/singular-code-review/review_queue.json": "allow"
      },
      bash: "allow",
      webfetch: "allow"
    }
  });
  assert.deepEqual(config.provider["opencode-go"], {
    options: {
      apiKey: "{env:OPENCODE_API_KEY}"
    }
  });
  assert.deepEqual(config.mcp.context7, {
    type: "local",
    command: ["context7-mcp"],
    enabled: true,
    environment: {
      CONTEXT7_API_KEY: "{env:CONTEXT7_API_KEY}"
    }
  });

  assert.equal(
    fs.readFileSync(path.join(harness.dir, "home", ".config", "opencode", "AGENTS.md"), "utf8"),
    fs.readFileSync(path.join(repoRoot, "opencode", "AGENTS.md"), "utf8")
  );
});

test("separates opencode run file attachments from the prompt", () => {
  const harness = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "run" && "\${2:-}" == "--help" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "run" ]]; then
  if [[ "$*" != *"opencode_review_output.log"* ]]; then
    printf '%s\\n' "$@" > "$OPENCODE_ARGS_FILE"
  fi
  printf 'LGTM.\n'
  exit 0
fi
echo "unexpected opencode invocation: $*" >&2
exit 1
`);
  const argsFile = path.join(harness.dir, "opencode-args.txt");

  runOrchestrator(harness, {
    OPENCODE_ARGS_FILE: argsFile
  });

  const args = fs.readFileSync(argsFile, "utf8").trimEnd().split("\n");
  const separatorIndex = args.indexOf("--");
  assert.notEqual(separatorIndex, -1);
  assert.deepEqual(args.slice(0, 3), ["run", "--agent", "reviewer"]);
  assert.equal(args[separatorIndex - 1], path.join(harness.dir, "pr.diff"));
  assert.match(args[separatorIndex + 1], /^Review this pull request using the normalized context /);
  assert.match(args[separatorIndex + 1], /top-level @singular-code-review trigger comment/);
  assert.match(args[separatorIndex + 1], /--body-stdin/);
});

test("passes the validated queue to modern conclusion synthesis", () => {
  const harness = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "run" && "\${2:-}" == "--help" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "run" ]]; then
  if [[ "$*" == *"Audit the queued pull request review comments"* ]]; then
    printf 'Audit complete.\\n'
    exit 0
  fi
  if [[ "$*" == *"Synthesize a concise, polished GitHub pull request review body"* ]]; then
    printf '%s\\n' "$@" > "$OPENCODE_CONCLUSION_ARGS_FILE"
    printf '> reviewer · minimax-m2.7\\n\\nRequest changes: keep the queued finding.\\n'
    exit 0
  fi
  review_comments add --path "src/app.js" --line "2" --body "The new timeout can become NaN and break callers."
  printf '> reviewer · minimax-m2.7\\nQueued one finding.\\n'
  exit 0
fi
echo "unexpected opencode invocation: $*" >&2
exit 1
`);
  const outputFile = path.join(harness.dir, "opencode_review_output.log");
  const argsFile = path.join(harness.dir, "opencode-conclusion-args.txt");

  runOrchestrator(harness, {
    OPENCODE_OUTPUT_FILE: outputFile,
    OPENCODE_CONCLUSION_ARGS_FILE: argsFile
  });

  const args = fs.readFileSync(argsFile, "utf8").trimEnd().split("\n");
  const separatorIndex = args.indexOf("--");
  assert.notEqual(separatorIndex, -1);
  assert(args.includes(`${outputFile}.sanitized`));
  assert(args.includes(path.join(harness.dir, "review_validated.json")));
  assert.match(args[separatorIndex + 1], /validated queue as the source of truth/);

  const payload = JSON.parse(fs.readFileSync(harness.apiPayloadFile, "utf8"));
  assert.equal(payload.body, "> reviewer · minimax-m2.7\n\nRequest changes: keep the queued finding.");
});

test("keeps default review runtime files inside the git checkout", () => {
  const harness = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "run" && "\${2:-}" == "--help" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "run" ]]; then
  if [[ "$*" != *"opencode_review_output.log"* ]]; then
    printf '%s\\n' "$@" > "$OPENCODE_ARGS_FILE"
  fi
  printf 'LGTM.\n'
  exit 0
fi
echo "unexpected opencode invocation: $*" >&2
exit 1
`);
  fs.mkdirSync(path.join(harness.workspace, ".git"));
  const argsFile = path.join(harness.dir, "opencode-args.txt");

  runOrchestrator(
    harness,
    {
      OPENCODE_ARGS_FILE: argsFile
    },
    {
      useDefaultReviewFiles: true
    }
  );

  const args = fs.readFileSync(argsFile, "utf8").trimEnd().split("\n");
  assert(args.includes(path.join(harness.workspace, ".git", "singular-code-review", "review_context.json")));
  assert(args.includes(path.join(harness.workspace, ".git", "singular-code-review", "pr.diff")));
});

test("submits queued replies to existing review comments", () => {
  const harness = makeHarness(`#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "run" && "\${2:-}" == "--help" ]]; then
  exit 1
fi
if [[ "$*" == *"Audit the queued pull request review comments"* ]]; then
  printf 'Audit complete.\n'
  exit 0
fi
review_comments reply --to "456" --body "This still needs a fix."
`);

  runOrchestrator(harness);

  const payload = JSON.parse(fs.readFileSync(`${harness.apiPayloadFile}.reply`, "utf8"));
  assert.deepEqual(payload, { body: "This still needs a fix." });
});
