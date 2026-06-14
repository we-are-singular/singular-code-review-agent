#!/usr/bin/env bash
set -euo pipefail

rm -f dist/prompts/*.md
tsc -p tsconfig.json

mkdir -p dist/prompts
cp src/prompts/*.md dist/prompts/
