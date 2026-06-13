const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

test("reviewer image pins Node 26 and native addon build tooling", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

  assert.match(dockerfile, /^ARG NODE_VERSION=26\.3\.0$/m);
  assert.match(dockerfile, /^ARG NPM_MIN_VERSION=11\.13\.0$/m);
  assert.match(dockerfile, /\bbuild-essential\b/);
  assert.match(dockerfile, /\bpython3\b/);
  assert.match(dockerfile, /\bxz-utils\b/);
  assert.match(dockerfile, /below required/);
  assert.match(dockerfile, /PYTHON=\/usr\/bin\/python3/);
});
