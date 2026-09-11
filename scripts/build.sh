#!/usr/bin/env bash
set -euo pipefail

rm -rf dist
tsc -p tsconfig.json
cp -R src/instructions dist/instructions
cp src/lib/opencode-usage.sh dist/lib/opencode-usage.sh
chmod +x dist/lib/opencode-usage.sh
