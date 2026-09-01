import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

const workflow = fs.readFileSync(path.resolve(".github/workflows/review.yml"), "utf8")

test("review workflow falls back only after a safe pre-publication failure", () => {
  assert.match(
    workflow,
    /REVIEW_FALLBACK_MODEL: \$\{\{ vars\.REVIEW_FALLBACK_MODEL \|\| vars\.OPENCODE_MODEL_FALLBACK \|\| 'opencode-go\/minimax-m3' \}\}/u
  )
  assert.match(workflow, /if \[ "\$primary_status" -ne 2 \]; then\s+exit "\$primary_status"/u)
  assert.match(workflow, /timeout-minutes: 42/u)
  assert.match(
    workflow,
    /REVIEW_MODEL="\$REVIEW_FALLBACK_MODEL" timeout 20m \/usr\/local\/bin\/review_runner --publish/u
  )
})
