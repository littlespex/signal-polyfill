#!/bin/bash
set -euo pipefail
measure() { pnpm exec esbuild "$@" --bundle --format=esm --minify --target=es2022 | gzip -9 | wc -c | tr -d ' '; }
preact_entry="export * from '@preact/signals-core'"
# Assign before printing: set -e fires on a failed assignment, but not inside echo "$(...)".
# pipefail makes measure return esbuild's exit status.
poly=$(measure src/index.ts)
poly_no_legal=$(measure src/index.ts --legal-comments=none)
preact=$(echo "$preact_entry" | measure)
preact_no_legal=$(echo "$preact_entry" | measure --legal-comments=none)
echo "polyfill $poly bytes min+gzip"
echo "polyfill $poly_no_legal bytes min+gzip, --legal-comments=none"
echo "preact   $preact bytes min+gzip"
echo "preact   $preact_no_legal bytes min+gzip, --legal-comments=none"
