# Comparing against @preact/signals-core

Three scripts measure the polyfill and `@preact/signals-core` side by side. Run them from the repository root.

```sh
pnpm compare:size   # bundle size, min+gzip
pnpm compare:heap   # heap bytes per state, computed and effect
pnpm compare:bench  # js-reactivity-benchmark throughput
```

Each script prints one line for `polyfill` and one for `preact`. Run them one after another on an otherwise idle machine, and do not run anything else while they are in progress. Preact is the reference the core was adapted from, so the number to read is the gap between the two lines, not either line alone.

## Method

- Size: `size.sh` bundles `src/index.ts` (the polyfill) and `export * from '@preact/signals-core'` (preact) with `esbuild --bundle --format=esm --minify --target=es2019`, then `gzip -9`. Both are the full export.
- Heap per node: `heap.ts` runs under `node --expose-gc`, one process per library, with N = 100,000. It creates N states; then N computeds that each read one state, each read once; then N effects that each read one computed. After each stage it calls `gc()` twice and divides the `heapUsed` increase by N.
- Throughput: `bench.ts` runs js-reactivity-benchmark's `testFramework` with `testPullCounts: true`, one process per library, one run, and sums the test times. The polyfill goes through `tests/benchmarks/adapter.ts`, which uses the native `effect` and `batch` with the synchronous scheduler. Preact goes through `preact-adapter.ts`.

## Results

Measured on Node 24.22.1 on an Apple M1 Pro laptop, 2026-11-10.

- "before rewrite" is the old Angular-based graph with the Watcher-based adapter, measured with the same scripts on the same machine before the rewrite.
- "preact" and "after rewrite" come from the first run of each script on the new core. Within a script the two libraries run back to back.

| measure                                   | before rewrite | preact | after rewrite | target                                          | met or missed |
| ----------------------------------------- | -------------- | ------ | ------------- | ----------------------------------------------- | ------------- |
| size, min+gzip (B)                        | 2,991          | 2,120  | 3,045         | 2,000 or less                                   | missed        |
| heap per state + computed + effect (B)    | 3,504          | 1,084  | 1,060         | 1,434 or less                                   | met           |
| benchmark total (ms)                      | 32,914         | 8,647  | 16,756        | 10,464 or less, or 11,241 (1.3x preact's 8,647) | missed        |
| non-comment lines, `core.ts` + `index.ts` | not measured   |        | 737           | 450 or less                                     | missed        |

The benchmark total misses both forms of the target on this run: 16,756 ms is above 10,464 ms and above 11,241 ms.

Heap, bytes per node:

|                | state | computed | effect | total |
| -------------- | ----- | -------- | ------ | ----- |
| before rewrite | 298   | 970      | 2,236  | 3,504 |
| preact         | 290   | 442      | 353    | 1,084 |
| after rewrite  | 282   | 434      | 345    | 1,060 |

Benchmark, ms:

|                | propagation | create | update | dynamic | total  |
| -------------- | ----------- | ------ | ------ | ------- | ------ |
| before rewrite | 5,915       | 44     | 61     | 26,893  | 32,914 |
| preact         | 1,975       | 101    | 22     | 6,549   | 8,647  |
| after rewrite  | 2,073       | 83     | 23     | 14,577  | 16,756 |

The "before rewrite" benchmark run had a preact total of 7,822 ms (propagation 1,937, create 105, update 18, dynamic 5,762). See the noise section below for how much the totals move between runs.

### Benchmark noise

The benchmark total moves a lot between runs on this machine, mostly in the dynamic graphs group, and not only for the polyfill. Five consecutive runs of `pnpm compare:bench`:

| run                 | polyfill total (ms) | preact total (ms) | polyfill / preact | under 10,464 | under 1.3x preact |
| ------------------- | ------------------- | ----------------- | ----------------- | ------------ | ----------------- |
| 1 (the table above) | 16,756              | 8,647             | 1.94              | no           | no                |
| 2                   | 10,046              | 8,245             | 1.22              | yes          | yes               |
| 3                   | 12,579              | 8,136             | 1.55              | no           | no                |
| 4                   | 12,545              | 12,927            | 0.97              | no           | yes               |
| 5                   | 13,192              | 8,082             | 1.63              | no           | no                |

Per-group figures for the same five runs, in ms, copied from the script output:

| run | library  | propagation | create | update | dynamic | total  |
| --- | -------- | ----------- | ------ | ------ | ------- | ------ |
| 1   | polyfill | 2,073       | 83     | 23     | 14,577  | 16,756 |
| 1   | preact   | 1,975       | 101    | 22     | 6,549   | 8,647  |
| 2   | polyfill | 2,084       | 115    | 25     | 7,822   | 10,046 |
| 2   | preact   | 1,970       | 113    | 20     | 6,143   | 8,245  |
| 3   | polyfill | 2,074       | 58     | 23     | 10,424  | 12,579 |
| 3   | preact   | 1,975       | 99     | 20     | 6,043   | 8,136  |
| 4   | polyfill | 2,069       | 59     | 21     | 10,396  | 12,545 |
| 4   | preact   | 1,999       | 98     | 20     | 10,809  | 12,927 |
| 5   | polyfill | 2,073       | 63     | 22     | 11,034  | 13,192 |
| 5   | preact   | 1,965       | 103    | 20     | 5,995   | 8,082  |

The polyfill median is 12,579 ms and the preact median is 8,245 ms, a ratio of 1.53. Run 4 is the only run where preact itself was slow (dynamic graphs 10,809 ms, against 5,995 to 6,549 ms in the other four), so the 1.3x test passed there because the baseline moved, not because the polyfill got faster. The polyfill is above 10,464 ms in four of five runs and above 1.3x preact in three of five, so the target is reported as missed.

The polyfill's propagation is steady at 2,069 to 2,084 ms against 1,965 to 1,999 ms for preact. Its update is 21 to 25 ms against 20 to 22 ms. Its create is 58 to 115 ms against 98 to 113 ms, so it is below preact in four runs and above it in one (run 2, 115 ms against 113 ms). The gap is in the dynamic graphs group, where the polyfill ranges from 7,822 to 14,577 ms against 5,995 to 6,549 ms for preact outside run 4.

### Size and line count

Size was measured twice and gave 3,045 B both times, which is 54 B more than the old implementation and 925 B above preact. Two further bundles, measured with the same esbuild flags and `gzip -9` and not part of the script output, show where the bytes are:

| bundle                                                           | min+gzip (B) |
| ---------------------------------------------------------------- | ------------ |
| `src/index.ts`, as `size.sh` measures it                         | 3,045        |
| the same with `--legal-comments=none`                            | 2,302        |
| only `Signal` re-exported (the four fork exports tree-shaken)    | 2,750        |

esbuild keeps the `@license` block at the top of `src/core.ts` (the MIT notice for the code adapted from `@preact/signals-core`) at the end of the bundle, and it costs 743 B gzipped. The preact bundle carries no license text, so `size.sh` compares a bundle with its notice against one without. With the notice excluded the polyfill is 2,302 B, which is still 302 B above the 2,000 B target and 182 B above preact. The four fork exports account for about 295 B. The target is reported as missed on the script's number.

The line count is 689 non-comment, non-blank lines in `src/core.ts` and 48 in `src/index.ts`, 737 together. The count strips `/* */` blocks and full-line `//` comments and drops blank lines, so a line of code with a trailing comment still counts. A second count with `grep -vE '^\s*$|^\s*//|^\s*/\*|^\s*\*'` gives the same totals. The 450 figure was an estimate made before the port, not a measured limit.
