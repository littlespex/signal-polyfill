# Comparing against @preact/signals-core

Three scripts measure the polyfill and `@preact/signals-core` side by side. Run them from the repository root.

```sh
pnpm compare:size   # bundle size, min+gzip
pnpm compare:heap   # heap bytes per state, computed and effect
pnpm compare:bench  # js-reactivity-benchmark throughput
```

`compare:size` prints two lines per library and the other two print one line per library. Run them one after another on an otherwise idle machine, and do not run anything else while they are in progress. Preact is the reference the core was adapted from, so the number to read is the gap between the libraries, not either figure alone.

## Method

- Size: `size.sh` bundles `src/index.ts` (the polyfill) and `export * from '@preact/signals-core'` (preact) with `esbuild --bundle --format=esm --minify --target=es2022`, then `gzip -9`. It prints each bundle twice: with esbuild's default handling of legal comments, and with `--legal-comments=none`. Both bundles are the full export.
- Heap per node: `heap.ts` runs under `node --expose-gc`, one process per library, with N = 100,000. It creates N states; then N computeds that each read one state, each read once; then N effects that each read one computed. After each stage it calls `gc()` twice and divides the `heapUsed` increase by N. Each figure, the total included, is rounded on its own from the raw byte count, so the total can differ by 1 from the sum of the three per-node figures.
- Throughput: `bench.ts` runs js-reactivity-benchmark's `testFramework` with `testPullCounts: true`, one process per library, and sums the test times. The polyfill goes through `tests/benchmarks/adapter.ts`, which uses the native `effect` and `batch` with the synchronous scheduler. Preact goes through `preact-adapter.ts`.
- Builds: the polyfill is bundled from its TypeScript source. `@preact/signals-core` resolves to its published build (`dist/signals-core.mjs`, minified with terser), which is a few percent faster than preact bundled from its own source.
- Runs: the benchmark figure is the median of five runs per library, alternating which library goes first. Run 1 is `pnpm compare:bench`, which builds `build/bench.js` and runs the polyfill and then preact. Runs 2 to 5 call `node --expose-gc build/bench.js polyfill` and `node --expose-gc build/bench.js preact` directly, with preact first in runs 2 and 4. The load average is printed before each run.

## Results

Measured on Node 24.22.1 on an Apple M1 Pro laptop, 2026-11-10, at commit 5ff8840. The machine was not idle: the 1-minute load average was between 6.09 and 13.68 before the runs, from background processes outside this repository.

- "before rewrite" is the old Angular-based graph with the Watcher-based adapter, measured with the same scripts on the same machine before the rewrite. Its benchmark figure is a single run. Its size was measured again at the ES2022 target, from the source at commit cabb083.
- "preact" and "after rewrite" come from the measurements above. Size and heap are one run of each script. The benchmark rows are medians of the five runs listed below.
- The size figures were measured again after the build target moved from ES2019 to ES2022. The heap and benchmark bundles are built without a target, so those figures did not change.

| measure                                     | before rewrite   | preact | after rewrite | target                                          | met or missed |
| ------------------------------------------- | ---------------- | ------ | ------------- | ----------------------------------------------- | ------------- |
| size, min+gzip (B)                          | 2,540            | 2,114  | 3,048         | 2,000 or less                                   | missed        |
| size, min+gzip, `--legal-comments=none` (B) | 2,082            | 2,114  | 2,305         | 2,000 or less                                   | missed        |
| heap per state + computed + effect (B)      | 3,504            | 1,084  | 1,060         | 1,434 or less                                   | met           |
| benchmark total, median of five runs (ms)   | 32,914 (one run) | 8,192  | 11,258        | 10,464 or less, or 10,650 (1.3x preact's 8,192) | missed        |
| benchmark dynamic group, median (ms)        | 26,893 (one run) | 6,104  | 9,168         | none                                            |               |
| non-comment lines                           | not measured     | 750    | 750           | 450 or less                                     | missed        |

The benchmark medians miss both forms of the target: 11,258 ms is above 10,464 ms and above 10,650 ms. The ratio of the medians is 1.37.

Heap, bytes per node:

|                | state | computed | effect | total |
| -------------- | ----- | -------- | ------ | ----- |
| before rewrite | 298   | 970      | 2,236  | 3,504 |
| preact         | 290   | 442      | 353    | 1,084 |
| after rewrite  | 282   | 434      | 344    | 1,060 |

Preact's three figures add up to 1,085 and its total is 1,084, because each figure is rounded on its own.

### Benchmark runs

Per-group figures in ms, copied from the script output. "load" is the 1-minute load average printed before the run.

| run | first    | load  | library  | propagation | create | update | dynamic | total  |
| --- | -------- | ----- | -------- | ----------- | ------ | ------ | ------- | ------ |
| 1   | polyfill | 6.09  | polyfill | 2,008       | 59     | 23     | 9,168   | 11,258 |
| 1   | polyfill | 6.09  | preact   | 1,953       | 120    | 32     | 6,125   | 8,230  |
| 2   | preact   | 6.88  | preact   | 1,963       | 105    | 20     | 6,104   | 8,192  |
| 2   | preact   | 6.88  | polyfill | 2,037       | 101    | 43     | 10,036  | 12,217 |
| 3   | polyfill | 13.68 | polyfill | 2,025       | 59     | 23     | 9,895   | 12,003 |
| 3   | polyfill | 13.68 | preact   | 1,958       | 106    | 19     | 5,906   | 7,989  |
| 4   | preact   | 8.45  | preact   | 1,972       | 98     | 19     | 5,880   | 7,969  |
| 4   | preact   | 8.45  | polyfill | 2,017       | 62     | 23     | 5,520   | 7,622  |
| 5   | polyfill | 9.62  | polyfill | 2,008       | 61     | 22     | 6,185   | 8,277  |
| 5   | polyfill | 9.62  | preact   | 1,992       | 116    | 20     | 6,445   | 8,572  |

| run | polyfill total (ms) | preact total (ms) | polyfill / preact |
| --- | ------------------- | ----------------- | ----------------- |
| 1   | 11,258              | 8,230             | 1.37              |
| 2   | 12,217              | 8,192             | 1.49              |
| 3   | 12,003              | 7,989             | 1.50              |
| 4   | 7,622               | 7,969             | 0.96              |
| 5   | 8,277               | 8,572             | 0.97              |

The polyfill's dynamic group splits into two clusters: 9,168 to 10,036 ms in runs 1 to 3, and 5,520 and 6,185 ms in runs 4 and 5. Preact's dynamic group stays between 5,880 and 6,445 ms in all five runs. In runs 4 and 5 the polyfill total is below preact's in the same run. The clusters do not line up with the load average: run 1 started at 6.09 and was slow, and run 4 started at 8.45 and was fast. The median falls in the slow cluster.

Outside the dynamic group the two are close in every run. Propagation is 2,008 to 2,037 ms against 1,953 to 1,992 ms for preact, create is 59 to 101 ms against 98 to 120 ms, and update is 22 to 43 ms against 19 to 32 ms.

### Size and line count

| bundle                                                        | default (B) | `--legal-comments=none` (B) |
| ------------------------------------------------------------- | ----------- | --------------------------- |
| `src/index.ts`, as `size.sh` measures it                      | 3,048       | 2,305                       |
| only `Signal` re-exported (the four fork exports tree-shaken) | 2,745       | 2,010                       |
| preact, as `size.sh` measures it                              | 2,114       | 2,114                       |

The "only `Signal`" row is not part of the script output. It was measured with the same esbuild flags and `gzip -9`, bundling `export {Signal} from './src/index.ts'`.

esbuild keeps the `@license` block at the top of `src/core.ts` (the MIT notice for the code adapted from `@preact/signals-core`) at the end of the bundle, and it costs 743 B gzipped. The preact bundle carries no license text, so its two figures are equal. With the notice excluded the polyfill is 2,305 B, which is still 305 B above the 2,000 B target and 191 B above preact. The four fork exports account for about 300 B (295 B without the notice). At this target the old graph is 2,082 B without license comments, because it used class fields, which ES2022 output keeps as they are. So the rewrite with its four fork exports is 223 B larger than the old graph, and the `Signal`-only bundle is 72 B smaller. The target is reported as missed both ways.

The line count is 696 non-comment, non-blank lines in `src/core.ts` and 54 in `src/index.ts`, 750 together. The count strips `/* */` blocks and full-line `//` comments and drops blank lines, so a line of code with a trailing comment still counts. A second count with `grep -vE '^\s*$|^\s*//|^\s*/\*|^\s*\*'` gives the same totals. Preact's `src/index.ts` (1.14.5) has 750 lines by the `grep` count and 754 by the first count: four of its lines start with an `@__INLINE__` comment before a `startBatch()` call, and the `grep` count drops them. The 450 figure was an estimate made before the port, not a measured limit.
