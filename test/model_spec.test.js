import assert from "node:assert/strict"
import test from "node:test"

import { parseModelSpec } from "../dist/cli/review.js"

test("model specifications split an optional reasoning effort suffix", () => {
  assert.deepEqual(parseModelSpec("gpt/luna"), { model: "gpt/luna" })
  assert.deepEqual(parseModelSpec("gpt/luna:max"), { model: "gpt/luna", reasoningEffort: "max" })
  assert.deepEqual(parseModelSpec("gpt/luna:max:unused"), {
    model: "gpt/luna",
    reasoningEffort: "max:unused"
  })
  assert.deepEqual(parseModelSpec("gpt/luna:"), { model: "gpt/luna" })
})
