const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildModernArgs,
  findSessionID,
  parseArgs,
  textFromJsonEvent
} = require("../bin/opencode_step");

test("extracts session ids and text from OpenCode JSON events", () => {
  assert.equal(
    findSessionID({
      type: "tool",
      properties: {
        part: {
          sessionID: "ses_123"
        }
      }
    }),
    "ses_123"
  );

  assert.equal(textFromJsonEvent({ type: "text", text: "Review body" }), "Review body");
  assert.equal(textFromJsonEvent({ event: { part: { type: "text", text: "Nested text" } } }), "Nested text");
});

test("builds modern OpenCode args with explicit session reuse", () => {
  const sessionFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-step-")), "session.txt");
  const options = parseArgs([
    "--workspace",
    "/repo",
    "--output",
    "/tmp/out.log",
    "--agent",
    "reviewer",
    "--session-file",
    sessionFile,
    "--reuse-session",
    "--file",
    "/tmp/context.json",
    "--file",
    "/tmp/pr.diff",
    "--prompt",
    "Review this"
  ]);

  fs.writeFileSync(sessionFile, "ses_456\n");
  const args = buildModernArgs(options, {
    formatJson: true,
    file: true,
    session: true
  });

  assert.deepEqual(args.slice(0, 7), ["run", "--agent", "reviewer", "--format", "json", "--session", "ses_456"]);
  assert(args.includes("/tmp/context.json"));
  assert(args.includes("/tmp/pr.diff"));
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), "Review this");
});
