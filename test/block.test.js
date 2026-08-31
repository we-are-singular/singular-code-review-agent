import assert from "node:assert/strict"
import test from "node:test"

import { AmlRuntime } from "@aml-jsx/sdk"
import { jsx } from "@aml-jsx/sdk/jsx-runtime"

import { Block } from "../dist/components/block.js"

test("Block separates empty and child-bearing AML forms without coercing children", async () => {
  function Child() {
    return ["nested", 2]
  }

  const output = await new AmlRuntime().evaluate([
    "first",
    jsx(Block, { children: jsx(Child, {}) }),
    "third",
    jsx(Block, {}),
    "fourth"
  ])

  assert.equal(output, "first\n\nnested2\n\nthird\n\nfourth")
})
