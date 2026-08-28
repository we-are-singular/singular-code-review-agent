#!/usr/bin/env bash
set -euo pipefail

rm -rf dist/aml dist/src
rm -f dist/prompts/*.md
tsc -p tsconfig.json
tsc -p tsconfig.aml.json

mkdir -p dist/prompts
cp src/prompts/*.md dist/prompts/
cp aml/review-skill.md dist/aml/review-skill.md
