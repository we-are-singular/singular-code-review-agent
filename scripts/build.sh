#!/usr/bin/env bash
set -euo pipefail

rm -rf dist
tsc -p tsconfig.json
cp -R src/skills dist/skills
