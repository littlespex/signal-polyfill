# Signal Core Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Angular-derived signal graph with one small core module that keeps the TC39 `Signal` API, adds `effect`, `batch`, `flush` and `setScheduler`, and reaches preact parity on memory and throughput.

**Architecture:** `src/core.ts` holds the whole graph: linked dependency edges, version counters, flag bits, the `State`, `Computed`, `Watcher` and `Effect` classes, and the pending-effect queue. It is a port of the algorithm in `@preact/signals-core` with the differences each task lists. `src/index.ts` assembles the public `Signal` namespace with narrowed types and re-exports the four functions.

**Tech Stack:** TypeScript 5.4, Vite 5 library build (esbuild), vitest 1.x, pnpm 9, js-reactivity-benchmark.

**Spec:** `docs/superpowers/specs/2026-11-10-core-rewrite-design.md`. Read it before any task. Its "Amendments from planning" section records where this plan refines its wording.

## Global Constraints

- Build output is ES2019 with no helper functions. Source uses no class field initializers, no `#private` names, no static blocks. Declare field types without initializers and assign them in the constructor. Optional chaining and `??` are allowed.
- `queueMicrotask` is the microtask primitive.
- Reference implementation: `node_modules/@preact/signals-core/src/index.ts` (available after Task 1). Internal members keep the reference's names (`_sources`, `_targets`, `_flags`, `_version`, `_node`, `_refresh`, `_subscribe`, `_unsubscribe`, `_notify`), and the flag constants keep its names and values.
- Never port from the reference: batch snapshots (`recordBatchSnapshot`, `reconcileBatchSnapshots`), `capturedEffects`, `action`, `createModel`, `subscribe`, `peek`, `toJSON`, `valueOf`, `toString`, `brand`, the `name` option.
- `src/core.ts` starts with a `/** @license */` comment saying the graph algorithm is adapted from `@preact/signals-core`, followed by the copyright line and MIT permission notice copied from `node_modules/@preact/signals-core/LICENSE`. No Google license headers in new files.
- Scripts are bash or TypeScript, never Python.
- Run `pnpm prettier --write` on every file you create or change (markdown is ignored by prettier).
- Prose in README, comments and commit messages uses no em dashes.
- Work on branch `claude/signal-polyfill-bundle-eval-c9cab5`. Do not push. Every commit message ends with the trailer `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Existing tests may change only in their import path. Error message wording is free, except where a test in this plan matches on it.

## Review Focus

Failure modes the spec implies but its test list does not cover, most likely first. Each has a test in the task that owns the code.

1. A Watcher notify callback throws while a write is propagating. Other live computeds must still be marked and must not return stale values. (Task 3)
2. An effect is disposed while queued, or disposes itself during its own run. It must not run again and must end up unsubscribed. (Task 4)
3. The callback passed to `batch` throws. The depth must be restored and pending effects must still flush. (Task 4)
4. `setScheduler` is called while effects are pending. They must not be stranded. (Task 4)
5. `flush()` is called from inside an effect. It must be a no-op, with no double runs. (Task 4)

---

### Task 1: Measurement scripts and baseline

**Files:**
- Create: `tests/benchmarks/compare/preact-adapter.ts`, `tests/benchmarks/compare/heap.ts`, `tests/benchmarks/compare/bench.ts`, `tests/benchmarks/compare/size.sh`
- Modify: `package.json` (devDependency, three scripts), `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `tc39SignalsProposalStage0` from `tests/benchmarks/adapter.ts` (a `ReactiveFramework`); `testFramework`, `ReactiveFramework` from `js-reactivity-benchmark`.
- Produces: `pnpm compare:size`, `pnpm compare:heap`, `pnpm compare:bench`; `preactFramework: ReactiveFramework` exported from `preact-adapter.ts`.

- [ ] **Step 1: Commit what is already in the working tree, as two commits**

```bash
git add package.json pnpm-lock.yaml vite.config.ts src
git commit -m "build: pin TypeScript 5, add package metadata, drop dead Angular branches"
git add docs
git commit -m "docs: core rewrite design and plan"
```

- [ ] **Step 2: Add the preact devDependency**

Run: `pnpm add -D @preact/signals-core@^1.14.5`
Expected: `node_modules/@preact/signals-core/src/index.ts` exists.

- [ ] **Step 3: Write `preact-adapter.ts`**

```ts
import {batch, computed, effect, signal} from '@preact/signals-core';
import type {ReactiveFramework} from 'js-reactivity-benchmark';

export const preactFramework: ReactiveFramework = {
  name: '@preact/signals-core',
  signal: (v) => {
    const s = signal(v);
    return {read: () => s.value, write: (x) => void (s.value = x)};
  },
  computed: (fn) => {
    const c = computed(fn);
    return {read: () => c.value};
  },
  effect: (fn) => void effect(() => void fn()),
  withBatch: (fn) => void batch(fn),
  withBuild: (fn) => fn(),
};
```

- [ ] **Step 4: Write `heap.ts`**

`process.argv[2]` is `polyfill` or `preact` and selects the framework. With N = 100,000: create N signals; then N computeds each reading one signal, each read once; then N effects each reading one computed. After each stage call `gc()` twice and take the `process.memoryUsage().heapUsed` increase divided by N. Keep every created object reachable until the end. Print one line:

```
polyfill  state 305  computed 980  effect 2294  total 3580  (bytes per node, N=100000)
```

- [ ] **Step 5: Write `bench.ts`**

`process.argv[2]` selects the framework. Run `testFramework({framework, testPullCounts: true}, cb)` and sum `result.time` into four groups by test name: starts with `create`; starts with `update`; contains `sources` (dynamic); everything else (propagation). Print one line:

```
preact  propagation 1931  create 100  update 19  dynamic 5999  total 8049  (ms)
```

- [ ] **Step 6: Write `size.sh`**

```bash
#!/bin/bash
set -euo pipefail
measure() { pnpm exec esbuild "$@" --bundle --format=esm --minify --target=es2019 | gzip -9 | wc -c | tr -d ' '; }
echo "polyfill $(measure src/index.ts) bytes min+gzip"
echo "preact   $(echo "export * from '@preact/signals-core'" | measure) bytes min+gzip"
```

- [ ] **Step 7: Add the scripts to `package.json`**

```json
"compare:size": "bash tests/benchmarks/compare/size.sh",
"compare:heap": "esbuild tests/benchmarks/compare/heap.ts --bundle --format=esm --platform=node --outdir=build && node --expose-gc build/heap.js polyfill && node --expose-gc build/heap.js preact",
"compare:bench": "esbuild tests/benchmarks/compare/bench.ts --bundle --format=esm --platform=node --outdir=build && node --expose-gc build/bench.js polyfill && node --expose-gc build/bench.js preact"
```

- [ ] **Step 8: Run all three and check the numbers are in range**

Run: `pnpm compare:size && pnpm compare:heap && pnpm compare:bench`
Expected on the old implementation: size polyfill 2,400 to 3,400 and preact 2,000 to 2,300; heap total polyfill 3,000 to 4,300 and preact 1,000 to 1,250; bench total preact 6,000 to 11,000 ms and polyfill at least 3x preact. A number outside its range means the script measures something different from the spec's method: fix the script, not the range.

- [ ] **Step 9: Commit**

```bash
git add tests/benchmarks/compare package.json pnpm-lock.yaml
git commit -m "test: add size, heap and throughput comparison scripts"
```

---

### Task 2: State and Computed, pull side

No node has targets after this task. Everything about liveness, notification, hooks and the Watcher is Task 3. The old implementation stays in place and keeps serving the nine test files that use a Watcher, so the full suite stays green.

**Files:**
- Create: `src/core.ts`
- Rewrite: `src/index.ts`
- Modify: import path in `tests/Signal/state.test.ts`, `tests/Signal/computed.test.ts`, `tests/Signal/subtle/currentComputed.test.ts`, `tests/Signal/subtle/untrack.test.ts`, `tests/Signal/ported/preact.test.ts`, `tests/Signal/ported/vue.test.ts`, `tests/behaviors/custom-equality.test.ts`, `tests/behaviors/cycles.test.ts`, `tests/behaviors/graph.test.ts`, `tests/behaviors/guards.test.ts` (all to the `src/index.js` module); `tests/benchmarks/adapter.ts` (import from `../../src/wrapper.js` until Task 3)

**Interfaces:**
- Produces, from `src/core.ts`:
  - `class State<T>` with `constructor(value: T, options?: {equals?: (a: T, b: T) => boolean})`, `get(): T`, `set(value: T): void`
  - `class Computed<T>` with `constructor(fn: () => T, options?: {equals?: (a: T, b: T) => boolean})`, `get(): T`
  - `untrack<T>(fn: () => T): T`, `currentComputed(): Computed<any> | undefined`
  - `introspectSources(sink: unknown): unknown[]`, `hasSources(sink: unknown): boolean`
  - `isState(x: unknown): boolean`, `isComputed(x: unknown): boolean`
- Produces, from `src/index.ts`: `export const Signal = {State, Computed, isState, isComputed, subtle: {untrack, currentComputed, introspectSources, hasSources}}`. This shell is temporary and untyped; Task 3 replaces it.

- [ ] **Step 1: Repoint the ten test files and the benchmark adapter**

- [ ] **Step 2: Replace `src/index.ts` with the shell above and create `src/core.ts` with the license header only**

Run: `pnpm vitest run tests/Signal/state.test.ts tests/behaviors/graph.test.ts`
Expected: FAIL, `State` is not exported from `./core.js`.

- [ ] **Step 3: Implement the pull side in `src/core.ts`**

Port from the reference: the flag constants, the `Node` type (name it `Edge`), `evalContext`, `globalVersion`, `untracked`, `addDependency`, `prepareSources`, `cleanupSources`, `needsToRecompute`, and `Computed.prototype._refresh`. Leave out `_targets`, `_subscribe`, `_unsubscribe`, `_notify`, every `TRACKING` branch, and hooks.

Differences from the reference that the tests and spec require:

- `State` and `Computed` are separate `class` declarations; neither extends the other. Every public method starts with a receiver check that throws `TypeError` when `this` is not an instance of its class.
- `_equals` is `options?.equals ?? Object.is`, invoked as `this._equals(a, b)` so `this` is the signal. `State.set` stores, bumps `_version` and `globalVersion` only when `_equals` returns false.
- `State.set` has no "computed cannot have side effects" check. Writes inside a computation are allowed.
- `addDependency` returns the existing edge when the same source is read again in one evaluation (the reference returns `undefined`). `get()` therefore always records `edge._version = this._version`. `prohibited-contexts › allows writes during computed` depends on this.
- A `Computed` starts with `_flags = OUTDATED`, `_version = 0`, `_globalVersion = globalVersion - 1`.
- The computation is invoked as `this._fn()` so `this` is the `Computed`.
- In `_refresh`, the new value replaces the old when `_version === 0`, or `HAS_ERROR` is set, or `!this._equals(this._value, value)`. Otherwise the old value is kept and `_version` does not change. The `_equals` call happens before `evalContext` is restored and inside the same `try` as the computation, so signals read by `equals` become dependencies and a throwing `equals` is cached as the error.
- `Computed.get()` throws an `Error` whose message contains "cycle" when `RUNNING` is set.
- `currentComputed()` returns `evalContext` when it is a `Computed`, otherwise `undefined`.
- `introspectSources` throws `TypeError` unless given a `Computed`, and returns the sources in list order, head first. `hasSources` has the same argument check.

- [ ] **Step 4: Run the ten files, then the whole suite**

Run: `pnpm vitest run tests/Signal/state.test.ts tests/Signal/computed.test.ts tests/Signal/subtle/currentComputed.test.ts tests/Signal/subtle/untrack.test.ts tests/Signal/ported tests/behaviors/custom-equality.test.ts tests/behaviors/cycles.test.ts tests/behaviors/graph.test.ts tests/behaviors/guards.test.ts`
Expected: 10 files pass.
Run: `pnpm vitest run && pnpm lint`
Expected: 19 files, 70 tests pass; lint passes.

- [ ] **Step 5: Commit**

```bash
git add src/core.ts src/index.ts tests
git commit -m "feat: new State and Computed core, pull side"
```

---

### Task 3: Liveness, Watcher, public types; remove the old implementation

**Files:**
- Modify: `src/core.ts`, `src/public-api-types.ts` (import from `./index.ts`), `tsconfig.json` (`target` to `ES2019`, `lib` to `["DOM", "ES2019"]`), `vite.config.ts` (`target: 'es2019'`)
- Rewrite: `src/index.ts`
- Delete: `src/wrapper.ts`, `src/graph.ts`, `src/computed.ts`, `src/signal.ts`, `src/equality.ts`, `src/errors.ts`
- Modify: import path in `tests/Signal/subtle/watcher.test.ts`, `tests/Signal/subtle/watch-unwatch.test.ts`, `tests/behaviors/dynamic-dependencies.test.ts`, `tests/behaviors/errors.test.ts`, `tests/behaviors/liveness.test.ts`, `tests/behaviors/prohibited-contexts.test.ts`, `tests/behaviors/pruning.test.ts`, `tests/behaviors/receivers.test.ts`, `tests/behaviors/type-checking.test.ts`, `tests/benchmarks/adapter.ts` (all to the `src/index.js` module)
- Test: `tests/behaviors/watcher-edge-cases.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces, from `src/core.ts`: `class Watcher` with `constructor(notify: (this: Watcher) => void)`, `watch(...signals)`, `unwatch(...signals)`, `getPending(): Computed<any>[]`; `WATCHED` and `UNWATCHED` (`unique symbol` constants); `introspectSinks(signal: unknown): unknown[]`, `hasSinks(signal: unknown): boolean`, `isWatcher(x: unknown): boolean`. `State` and `Computed` constructors now also read `options[WATCHED]` and `options[UNWATCHED]`.
- Produces, from `src/index.ts`: the typed `Signal` namespace described in Step 4.

- [ ] **Step 1: Write the failing tests in `tests/behaviors/watcher-edge-cases.test.ts`**

```ts
import {describe, expect, it} from 'vitest';
import {Signal} from '../../src/index.js';

describe('Watcher edge cases', () => {
  it('a throwing notify callback does not leave live signals stale', () => {
    const s = new Signal.State(1);
    const double = new Signal.Computed(() => s.get() * 2);
    const bad1 = new Signal.subtle.Watcher(() => {
      throw new Error('notify');
    });
    const bad2 = new Signal.subtle.Watcher(() => {
      throw new Error('notify');
    });
    const good = new Signal.subtle.Watcher(() => {});
    bad1.watch(s);
    good.watch(double);
    expect(double.get()).toBe(2);
    bad2.watch(s);

    expect(() => s.set(2)).toThrowError('notify');
    expect(good.getPending()).toEqual([double]);
    expect(double.get()).toBe(4);
    expect(() => s.set(3)).not.toThrow();
    expect(double.get()).toBe(6);
  });

  it('a clean computed is not pending right after watch', () => {
    const s = new Signal.State(1);
    const c = new Signal.Computed(() => s.get());
    c.get();
    const w = new Signal.subtle.Watcher(() => {});
    w.watch(c);
    expect(w.getPending()).toEqual([]);
  });
});
```

- [ ] **Step 2: Repoint the nine test files and the benchmark adapter, then run**

Run: `pnpm vitest run`
Expected: FAIL in the ten Watcher files, `Signal.subtle.Watcher` is not a constructor.

- [ ] **Step 3: Add liveness, notification and the Watcher to `src/core.ts`**

Port from the reference: `_targets`, `Signal.prototype._subscribe` and `_unsubscribe` (for `State`), `Computed.prototype._subscribe`, `_unsubscribe` and `_notify`, the `TRACKING` branches in `addDependency` and `cleanupSources`, and the `(flags & (OUTDATED | TRACKING)) === TRACKING` fast path in `_refresh`.

Differences from the reference:

- Going live: `Computed._subscribe`, on its first target, sets `TRACKING` and sets `OUTDATED` only when `this._globalVersion !== globalVersion`. The reference sets both unconditionally.
- Hooks: store `options[WATCHED]` and `options[UNWATCHED]` at construction. Call them with `this` as the signal, inside `untrack`, when the first target is gained and the last is lost.
- `State.set` notifies in two phases. Phase one calls `_notify()` on every target; no user code runs. Phase two calls the callback of every Watcher that phase one collected, with `this` as the watcher. All collected callbacks run even if one throws, and the first error is rethrown afterwards.
- A module-level `notifying` flag is true only during phase two and is reset in a `finally`. While it is true, `State.get`, `State.set` and `Computed.get` throw an `Error`.
- `Watcher._notify()`: if `NOTIFIED` is not set, set it and add the watcher to the phase-two list.
- `Watcher.watch(...signals)`: receiver check; every argument must be a `State` or `Computed`, checked before anything changes, else `TypeError`. Clears `NOTIFIED` even with no arguments. For each signal not already watched, creates an edge, appends it to the watcher's sources, and subscribes it. Never evaluates anything.
- `Watcher.unwatch(...signals)`: same checks. Unsubscribes and unlinks each watched signal; ignores signals that are not watched.
- `Watcher.getPending()`: receiver check; returns the watched `Computed`s whose `OUTDATED` flag is set, in watch order.
- `introspectSources` and `hasSources` also accept a `Watcher`. `introspectSinks` and `hasSinks` accept a `State` or `Computed`, else `TypeError`. `introspectSinks` returns the owners of the target edges that are a `Computed` or a `Watcher`; `hasSinks` is `_targets !== undefined`.

- [ ] **Step 4: Rewrite `src/index.ts` as the typed public shell**

The spec says internals are TypeScript-private. `private` members cannot be read by the graph functions or by sibling classes, so the public types are interfaces that omit the internals instead. Inside `export namespace Signal`, declare `interface State<T> {get(): T; set(value: T): void}`, `interface Computed<T> {get(): T}`, and in `namespace subtle` an `interface Watcher` with `watch`, `unwatch`, `getPending`. Beside each interface export a constant of the same name, typed as a constructor interface with a generic `new` signature and a `prototype` member, and assigned from the core class. Keep `Options<T>`, the `AnySignal` and `AnySink` aliases, and the `subtle` function signatures as they are in the old `src/wrapper.ts`; type `watched` and `unwatched` as `typeof WATCHED` and `typeof UNWATCHED`.

`src/public-api-types.ts` is the contract for these types. It must type-check with only its import path changed.

- [ ] **Step 5: Delete the six old source files; update `tsconfig.json` and `vite.config.ts`**

- [ ] **Step 6: Verify**

Run: `pnpm vitest run`
Expected: 20 files, 72 tests pass.
Run: `pnpm lint && pnpm build && grep -cE "__(publicField|privateIn|privateAdd|accessCheck|defProp)|WeakSet|#brand" dist/index.js`
Expected: lint and build pass; grep prints `0`.

- [ ] **Step 7: Commit**

```bash
git add -A src tests tsconfig.json vite.config.ts
git commit -m "feat: liveness, Watcher and public types on the new core; remove Angular graph"
```

---

### Task 4: Effects and scheduler

**Files:**
- Modify: `src/core.ts`, `src/index.ts`, `src/public-api-types.ts`
- Test: `tests/effect.test.ts`, `tests/scheduler.test.ts`, `tests/scheduler-default.test.ts`

**Interfaces:**
- Consumes: the graph from Tasks 2 and 3.
- Produces, exported from `src/core.ts` and re-exported from `src/index.ts`:

```ts
export type Scheduler = (flush: () => void) => void;
export function effect(fn: () => void | (() => void)): () => void;
export function batch<T>(fn: () => T): T;
export function flush(): void;
export function setScheduler(scheduler: Scheduler | null): void;
```

- [ ] **Step 1: Write `tests/effect.test.ts`**

```ts
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {Signal, effect, flush, setScheduler} from '../src/index.js';

describe('effect', () => {
  beforeEach(() => setScheduler(null));

  it('runs at creation and again on flush', () => {
    const s = new Signal.State(1);
    const seen: number[] = [];
    effect(() => void seen.push(s.get()));
    expect(seen).toEqual([1]);
    s.set(2);
    expect(seen).toEqual([1]);
    flush();
    expect(seen).toEqual([1, 2]);
  });

  it('runs once per flush however many sources changed', () => {
    const a = new Signal.State(1);
    const b = new Signal.State(2);
    const fn = vi.fn(() => void (a.get(), b.get()));
    effect(fn);
    a.set(10);
    b.set(20);
    a.set(11);
    flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not re-run when its sources end up equal', () => {
    const s = new Signal.State(1);
    const parity = new Signal.Computed(() => s.get() % 2);
    const fn = vi.fn(() => void parity.get());
    effect(fn);
    s.set(3);
    flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs cleanup before each re-run and on dispose', () => {
    const s = new Signal.State(1);
    const log: string[] = [];
    const dispose = effect(() => {
      const v = s.get();
      log.push(`run ${v}`);
      return () => void log.push(`cleanup ${v}`);
    });
    s.set(2);
    flush();
    dispose();
    expect(log).toEqual(['run 1', 'cleanup 1', 'run 2', 'cleanup 2']);
    s.set(3);
    flush();
    expect(log).toHaveLength(4);
  });

  it('makes its sources live and is hidden from introspectSinks', () => {
    const watched = vi.fn();
    const unwatched = vi.fn();
    const s = new Signal.State(1, {
      [Signal.subtle.watched]: watched,
      [Signal.subtle.unwatched]: unwatched,
    });
    const dispose = effect(() => void s.get());
    expect(watched).toHaveBeenCalledTimes(1);
    expect(Signal.subtle.hasSinks(s)).toBe(true);
    expect(Signal.subtle.introspectSinks(s)).toEqual([]);
    dispose();
    expect(unwatched).toHaveBeenCalledTimes(1);
    expect(Signal.subtle.hasSinks(s)).toBe(false);
  });

  it('drops sources it stops reading', () => {
    const flag = new Signal.State(true);
    const a = new Signal.State('a');
    const b = new Signal.State('b');
    const fn = vi.fn(() => void (flag.get() ? a.get() : b.get()));
    effect(fn);
    flag.set(false);
    flush();
    a.set('x');
    flush();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(Signal.subtle.hasSinks(a)).toBe(false);
    b.set('y');
    flush();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('effects on the same source run in creation order', () => {
    const s = new Signal.State(0);
    const order: string[] = [];
    for (const name of ['a', 'b', 'c']) effect(() => void (s.get(), order.push(name)));
    order.length = 0;
    s.set(1);
    flush();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('a throw on the first run disposes the effect and rethrows', () => {
    const s = new Signal.State(1);
    const fn = vi.fn(() => {
      s.get();
      throw new Error('boom');
    });
    expect(() => effect(fn)).toThrowError('boom');
    expect(Signal.subtle.hasSinks(s)).toBe(false);
    s.set(2);
    flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throw on a re-run is reported by flush and the effect stays subscribed', () => {
    const s = new Signal.State(0);
    const fn = vi.fn(() => {
      if (s.get() === 1) throw new Error('boom');
    });
    effect(fn);
    s.set(1);
    expect(() => flush()).toThrowError('boom');
    s.set(2);
    flush();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('a throwing cleanup disposes the effect', () => {
    const s = new Signal.State(0);
    const fn = vi.fn(() => {
      s.get();
      return () => {
        throw new Error('cleanup');
      };
    });
    effect(fn);
    s.set(1);
    expect(() => flush()).toThrowError('cleanup');
    expect(Signal.subtle.hasSinks(s)).toBe(false);
    s.set(2);
    flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('one failing effect does not stop the others', () => {
    const s = new Signal.State(0);
    const ok = vi.fn(() => void s.get());
    effect(() => {
      if (s.get() === 1) throw new Error('first');
    });
    effect(ok);
    effect(() => {
      if (s.get() === 1) throw new Error('second');
    });
    s.set(1);
    expect(() => flush()).toThrowError('first');
    expect(ok).toHaveBeenCalledTimes(2);
  });

  it('an effect can dispose itself during its own run', () => {
    const s = new Signal.State(0);
    let dispose = () => {};
    const fn = vi.fn(() => {
      if (s.get() === 1) dispose();
    });
    dispose = effect(fn);
    s.set(1);
    flush();
    expect(Signal.subtle.hasSinks(s)).toBe(false);
    s.set(2);
    flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('disposing a queued effect stops it from running', () => {
    const s = new Signal.State(0);
    const fn = vi.fn(() => void s.get());
    const dispose = effect(fn);
    s.set(1);
    dispose();
    flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('effects that write each other throw a cycle error instead of hanging', () => {
    const a = new Signal.State(0);
    const b = new Signal.State(0);
    effect(() => b.set(a.get() + 1));
    effect(() => a.set(b.get() + 1));
    expect(() => flush()).toThrowError(/cycle/i);
    expect(() => flush()).not.toThrow();
  });

  it('flush called from inside an effect is a no-op', () => {
    const s = new Signal.State(0);
    const inner = vi.fn(() => void s.get());
    effect(inner);
    effect(() => {
      s.get();
      flush();
    });
    s.set(1);
    flush();
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Write `tests/scheduler.test.ts`**

```ts
import {describe, expect, it, vi} from 'vitest';
import {Signal, batch, effect, flush, setScheduler} from '../src/index.js';

const sync = (f: () => void) => f();

function counted() {
  const a = new Signal.State(0);
  const b = new Signal.State(0);
  const fn = vi.fn(() => void (a.get(), b.get()));
  effect(fn);
  return {a, b, fn};
}

describe('scheduler', () => {
  it('manual: nothing runs until flush', async () => {
    setScheduler(null);
    const {a, fn} = counted();
    a.set(1);
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);
    flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('synchronous: runs at the end of each write', () => {
    setScheduler(sync);
    const {a, b, fn} = counted();
    a.set(1);
    expect(fn).toHaveBeenCalledTimes(2);
    b.set(1);
    expect(fn).toHaveBeenCalledTimes(3);
    a.set(1);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('batch coalesces writes, nests, and returns the callback result', () => {
    setScheduler(sync);
    const {a, b, fn} = counted();
    const result = batch(() => {
      a.set(1);
      batch(() => b.set(1));
      expect(fn).toHaveBeenCalledTimes(1);
      return 'done';
    });
    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('batch restores the depth and flushes when the callback throws', () => {
    setScheduler(sync);
    const {a, fn} = counted();
    expect(() =>
      batch(() => {
        a.set(1);
        throw new Error('boom');
      }),
    ).toThrowError('boom');
    expect(fn).toHaveBeenCalledTimes(2);
    a.set(2);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('synchronous: a write inside a computation flushes after the computation', () => {
    setScheduler(sync);
    const src = new Signal.State(1);
    const out = new Signal.State(0);
    const c = new Signal.Computed(() => {
      out.set(src.get() * 2);
      return src.get();
    });
    expect(c.get()).toBe(1);
    const seen: number[][] = [];
    effect(() => void seen.push([out.get(), Signal.subtle.untrack(() => c.get())]));
    src.set(5);
    expect(c.get()).toBe(5);
    expect(seen).toEqual([
      [2, 1],
      [10, 5],
    ]);
  });

  it('asks the scheduler once per pending flush', () => {
    const scheduler = vi.fn();
    setScheduler(scheduler);
    const {a, b, fn} = counted();
    a.set(1);
    b.set(1);
    a.set(2);
    expect(scheduler).toHaveBeenCalledTimes(1);
    scheduler.mock.calls[0][0]();
    expect(fn).toHaveBeenCalledTimes(2);
    a.set(3);
    expect(scheduler).toHaveBeenCalledTimes(2);
    setScheduler(null);
    flush();
  });

  it('setScheduler with effects already pending asks the new scheduler', () => {
    setScheduler(null);
    const {a, fn} = counted();
    a.set(1);
    setScheduler(sync);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Write `tests/scheduler-default.test.ts`**

This file never calls `setScheduler`, so it sees the default.

```ts
import {expect, it, vi} from 'vitest';
import {Signal, effect} from '../src/index.js';

it('default scheduler runs effects once, after a microtask', async () => {
  const s = new Signal.State(0);
  const fn = vi.fn(() => void s.get());
  effect(fn);
  s.set(1);
  s.set(2);
  expect(fn).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(fn).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 4: Run the three files**

Run: `pnpm vitest run tests/effect.test.ts tests/scheduler.test.ts tests/scheduler-default.test.ts`
Expected: FAIL, `effect` is not exported.

- [ ] **Step 5: Implement effects and the scheduler in `src/core.ts`**

Port from the reference: the `Effect` constructor, `_callback`, `_start`, `_notify`, `_dispose`, `cleanupEffect`, `disposeEffect`, `endEffect`. The reference's `startBatch`/`endBatch` are replaced by the following.

- Module state: `batchDepth`, a pending queue of effects, a `scheduled` flag, a `flushing` flag, and `scheduler`, which defaults to `(f) => queueMicrotask(f)`.
- The depth is raised around the `batch` callback, the notification in `State.set`, a `Computed` recompute, an effect run, and `flush`. Each lowers it in a `finally`. When the depth returns to zero with a non-empty queue, `scheduled` false and a non-null scheduler: set `scheduled` and call `scheduler(flush)`. A `Computed` lowers the depth only after its recompute has fully finished (value and version stored, `RUNNING` cleared), so an effect flushed at that point can read it.
- `Effect._notify()`: if `NOTIFIED` is not set, set it and add the effect to the queue.
- `flush()`: return at once if `flushing`. Clear `scheduled`. Then repeat while the queue is non-empty: take the queue as one pass and start a new empty queue; for each effect in the pass clear `NOTIFIED`, skip it if `DISPOSED`, skip it if `needsToRecompute` is false, otherwise run it and remember the first error thrown. Order within a pass must make effects subscribed to one source run in creation order. On the 101st pass, clear `NOTIFIED` on every queued effect, empty the queue, and throw an `Error` whose message contains "cycle". After the loop, rethrow the remembered error.
- `effect(fn)`: create the effect and run it; if that first run throws, dispose it and rethrow. Return its dispose function.
- Cleanup runs with `evalContext` undefined. If it throws, dispose the effect and let the error propagate like a throw from `fn`.
- `setScheduler(s)`: store `s`, clear `scheduled`, then apply the same "depth is zero and queue is non-empty" check as above.
- `introspectSinks` already skips anything that is not a `Computed` or `Watcher`, so effects stay hidden.

- [ ] **Step 6: Export the four functions and the `Scheduler` type from `src/index.ts`, and pin their types in `src/public-api-types.ts`**

```ts
expectTypeOf(effect).toEqualTypeOf<(fn: () => void | (() => void)) => () => void>();
expectTypeOf(batch(() => 1)).toEqualTypeOf<number>();
expectTypeOf(flush).toEqualTypeOf<() => void>();
expectTypeOf(setScheduler).parameter(0).toEqualTypeOf<Scheduler | null>();
```

- [ ] **Step 7: Verify**

Run: `pnpm vitest run && pnpm lint`
Expected: 23 files, 95 tests pass; lint passes.

- [ ] **Step 8: Commit**

```bash
git add src tests
git commit -m "feat: effect, batch, flush and setScheduler"
```

---

### Task 5: Benchmark adapter, README, measurements

**Files:**
- Modify: `tests/benchmarks/adapter.ts`, `README.md`
- Create: `tests/benchmarks/compare/README.md`

**Interfaces:**
- Consumes: `effect`, `batch`, `setScheduler` from `src/index.ts`; the three `compare:*` scripts.

- [ ] **Step 1: Rewrite `tests/benchmarks/adapter.ts` on the native API**

Remove the Watcher, `processPending` and the exported `effect` helper. Call `setScheduler((f) => f())` at module load. `effect: (fn) => void effect(() => void fn())`, `withBatch: (fn) => void batch(fn)`. `signal`, `computed` and `withBuild` are unchanged.

- [ ] **Step 2: Update `README.md`**

In the first example import `effect` from `signal-polyfill`. Replace the "Creating a simple effect" section with an "Effects and scheduling" section that documents the four exports with their signatures and this table:

| mode | install | effects run |
|---|---|---|
| microtask (default) | nothing | once, after the current task |
| synchronous | `setScheduler((flush) => flush())` | at the end of the outermost write, computation or `batch` |
| manual | `setScheduler(null)`, then call `flush()` | when the app calls `flush()`, for example from `timeupdate` |

State that these four are additions in this fork and are not part of the TC39 proposal. Keep the note about `Signal.subtle` and the decorator section.

- [ ] **Step 3: Run the measurements**

Run: `pnpm compare:size && pnpm compare:heap && pnpm compare:bench`
Record the output. Targets: size 2,000 B or less; heap total 1,434 B or less; bench total 10,464 ms or less, or within 1.3x of the preact total from the same run if the machine differs.

- [ ] **Step 4: Write `tests/benchmarks/compare/README.md`**

How to run the three scripts, the method (from the spec's "Measurement" section), and a results table with columns: before rewrite, preact, after rewrite, target, met or missed. Add the non-comment line count of `src/core.ts` plus `src/index.ts` against the 450 target. A missed target is reported, not hidden; do not change the code in this task to chase one.

- [ ] **Step 5: Final verification**

Run: `pnpm lint && pnpm build && pnpm vitest run && pnpm benchmarks`
Expected: all pass; `benchmarks.json` is written.
Run: `grep -cE "__(publicField|privateIn|privateAdd|accessCheck|defProp)|WeakSet" dist/index.js`
Expected: `0`.
Run: `pnpm vitest run --browser.name=chrome --browser.headless`
Expected: pass. If no Chrome driver is available locally, say so in the task report; CI covers Chrome and Firefox.

- [ ] **Step 6: Commit**

```bash
git add tests/benchmarks README.md
git commit -m "docs: effects and scheduling; bench: native effect adapter and results"
```
