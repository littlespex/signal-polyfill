#!/bin/bash
set -euo pipefail
measure() { pnpm exec esbuild "$@" --bundle --format=esm --minify --target=es2019 | gzip -9 | wc -c | tr -d ' '; }
echo "polyfill $(measure src/index.ts) bytes min+gzip"
echo "preact   $(echo "export * from '@preact/signals-core'" | measure) bytes min+gzip"
