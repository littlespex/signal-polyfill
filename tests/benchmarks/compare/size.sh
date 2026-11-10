#!/bin/bash
set -euo pipefail
measure() { pnpm exec esbuild "$@" --bundle --format=esm --minify --target=es2019 | gzip -9 | wc -c | tr -d ' '; }
# Assign before printing: set -e fires on a failed assignment, but not inside echo "$(...)".
# pipefail makes measure return esbuild's exit status.
poly=$(measure src/index.ts)
preact=$(echo "export * from '@preact/signals-core'" | measure)
echo "polyfill $poly bytes min+gzip"
echo "preact   $preact bytes min+gzip"
