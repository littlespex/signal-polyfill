# Signal core rewrite

Date: 2026-11-10. Status: draft for approval.

## Intent

This repository is littlespex's fork of the TC39 Signals polyfill. It will be the
reactivity layer for a video player that runs on devices with limited CPU and memory,
where state changes arrive at a few hertz from `timeupdate` and `progress` events.
We are early in adopting signals; nothing depends on the current internals.

The current implementation is Angular's reactive graph from around v17 with a
spec-shaped wrapper on top. Measured on 2026-11-09 against alien-signals, preact
and Angular 22, it is 1.5x the size of preact after the build fixes already on this
branch, uses 3.3x the memory per live node, and runs 4x slower than preact on
js-reactivity-benchmark. Half of its code exists for Angular's needs, not ours.

We want the simplest implementation that keeps the TC39 API shape, adds the
`effect` function every consumer of this polyfill ends up writing, and lets us
experiment with when effects run.

## Goals

1. Keep the public TC39 shape: `Signal.State`, `Signal.Computed`,
   `Signal.subtle.Watcher`, `Signal.subtle.untrack`, `Signal.subtle.currentComputed`,
   `Signal.subtle.introspectSources`, `Signal.subtle.introspectSinks`,
   `Signal.subtle.hasSinks`, `Signal.subtle.hasSources`, `Signal.subtle.watched`,
   `Signal.subtle.unwatched`, `Signal.Options`, and the non-spec guards
   `Signal.isState`, `Signal.isComputed`, `Signal.isWatcher` the tests use.
2. Add `effect`, `batch`, `flush` and `setScheduler` as named exports beside `Signal`.
3. Scheduling policy lives outside the core. The same app code must run unchanged
   under microtask, synchronous and manual flushing.
4. The existing test suite stays green: `tests/Signal/**`, `tests/behaviors/**`, and the
   ported preact and vue suites. Only error message text and import paths may change.
5. Memory and throughput at preact parity: within 1.3x of `@preact/signals-core` on
   the js-reactivity-benchmark total and on the per-node heap measurement. Bundle at
   or under 2.0 KB min+gzip for the full export. These are targets to report against,
   not gates. Baselines and method are in "Measurement" below.
6. One core module a reader can hold in their head. Target: core plus public shell
   under 450 lines excluding comments.
7. ES2019 output with no downlevel helpers.

## Non-goals

- Compatibility with upstream internals. Nothing from `graph.ts`, `computed.ts`,
  `signal.ts`, `equality.ts` or `errors.ts` survives.
- Hiding internals from determined callers. Private fields are ES2022 and off the
  table; TypeScript-private members are enough.
- Cross-realm brand checks. `instanceof` is acceptable for a fork.
- Debug names, devtools formatters, or any API beyond item 2 above.

## Anti-goals

Things that would make this a failure even if tests pass:

- A second object per signal that exists only to keep the spec class "pure", with a
  back-pointer and `.call(wrapper)` on every hook. The public class is the node.
- Scheduling policy baked into the core. If a microtask is queued anywhere other than
  the default scheduler, the design has been violated.
- Growing the graph to handle a case no test and no planned use needs.

## Constraints

- Build: Vite library mode as today, target `es2019`. TypeScript `target` and `lib`
  move to ES2019 (plus DOM) so unavailable APIs fail type-checking.
- Source style: no class fields, no private names, no static blocks. Optional chaining
  and nullish coalescing are allowed because esbuild lowers them without helpers.
  `queueMicrotask` is the microtask primitive.
- Tooling stays: pnpm, vitest (node, Chrome, Firefox in CI), prettier, the
  js-reactivity-benchmark job.
- License: new files carry no Google header. The repository stays Apache-2.0.

## Design

### One object per signal

`Signal.State`, `Signal.Computed`, `Signal.subtle.Watcher` and the internal effect
class are the graph nodes. Their state lives in TypeScript-private members assigned
in the constructor. There is no separate node object and no `wrapper` back-pointer;
`equals`, the computation, `watched` and `unwatched` are called with the instance as
`this`, which is what the spec asks for.

Receiver checks use `instanceof` against the class. `Signal.isState` and friends are
the same test.

### Edges

Dependencies are a doubly linked list of edge objects, one per (source, target) pair,
following preact's `Node`:

```
edge = { source, target, prevSource, nextSource, prevTarget, nextTarget, version, rollback }
```

Each consumer holds the tail of its sources list in evaluation order. Each producer
holds the head of its targets list. `version` on the edge is the source version last
seen by the target, so "has anything I read changed" is a walk over the sources list
comparing versions, with no per-node arrays. Edge objects are reused across
re-evaluations when the same source is read again; stale edges are unlinked after
evaluation. This is the part that fixes memory: a live computed with one source and
one target owns two edge objects instead of five arrays.

### Versions and flags

A global version counter increments on every `State` write. Each producer has its own
version that increments when its value changes under `equals`. Each node has a small
flags integer with bits for RUNNING (cycle detection), NOTIFIED (already told my
targets this round), OUTDATED (must re-check sources before trusting my value),
TRACKING (I am live: subscribed to my sources), HAS_ERROR (rethrow cached error),
DISPOSED (effect only).

NOTIFIED and OUTDATED are distinct on purpose. The current code's single `dirty` flag
is why the "live and not dirty means clean" fast path could not be added safely.

A Computed starts OUTDATED, because it has no value yet.

### Reading a Computed

`get()` refreshes, then returns the cached value or rethrows the cached error.
Refresh, in order: if RUNNING, throw the cycle error. If TRACKING and not OUTDATED,
the value is current (a live node that nobody notified has not changed). If the
global version has not moved since the last refresh, the value is current. Otherwise
walk sources: refresh each, and if any source version differs from the edge's
recorded version, recompute. Recompute runs the computation with this node as the
tracking context, compares with `equals` against the previous value when there was
one, and bumps the version only on change. Errors are caught, cached with HAS_ERROR,
and bump the version so dependents re-evaluate.

Writes inside a computation are allowed, as the existing test requires.

### Liveness

A node is live when it has at least one target. When a producer gains its first
target it fires `watched` and, if it is a Computed, subscribes to its own sources
(sets TRACKING). When it loses its last target it fires `unwatched` and, if a Computed,
unsubscribes and clears TRACKING. Effects and Watchers are always live. This is one
code path for both `State` and `Computed`; the hooks are plain optional callbacks
stored at construction.

Going live never runs a computation. A Computed that goes live after a `State` was
written since its last refresh may be stale, because it received no notifications
while it was not live. So when a Computed gains its first target, it is marked
OUTDATED if the global version has moved since its last refresh, and left clean
otherwise. The existing test "should not break a computed signal to watch it before
getting its value" covers this. Side effect: such a Computed appears in
`getPending()` until its next `get()`, even when the write was to an unrelated
`State`; the `get()` clears it without recomputing.

### Writing a State

`set()` compares with `equals`; if changed, stores, bumps the node and global
versions, then notifies each target. A Computed target that is not already NOTIFIED
sets OUTDATED and NOTIFIED and notifies its own targets. An effect target that is not
already NOTIFIED sets both flags and appends itself to the pending queue. A Watcher
target records the notification and, if not already notified since its last `watch()`,
calls the user callback immediately. During that callback a module-level
`notifying` flag is set and `get()` and `set()` throw, matching the current behavior
and tests. After notification, if the batch depth is zero, the core asks the
scheduler to flush.

### Effects

```ts
effect(fn: () => void | (() => void)): () => void
```

An effect runs `fn` once synchronously at creation, tracking what it reads, and keeps
any returned cleanup. When flushed it checks whether any source actually changed
(same version walk as a Computed, so an effect whose sources were notified but ended
up equal does not re-run), runs the previous cleanup, then runs `fn` again. The
returned dispose function runs the cleanup and unsubscribes from all sources. Writes
inside an effect are allowed. An effect created inside another effect or computation
is not owned by it; there is no scope tracking.

Errors, following preact where it has an answer:

- `fn` throws on the first run: the effect is disposed and the error is rethrown from
  `effect()`.
- `fn` throws on a re-run: the effect stays subscribed to what it read before the
  throw, so it runs again when one of those changes. The error is reported through
  `flush()` (see Scheduler).
- Cleanup runs with no tracking context. A cleanup that throws disposes the effect,
  and the error is reported the same way as a throwing `fn`.

### Scheduler

The core owns a pending queue of effects and a batch depth. It never decides when to
run the queue. Three exports control that:

- `flush()` drains the queue in FIFO order, including effects queued while draining.
  Errors are collected and the first is rethrown after the queue is empty, so one
  failing effect does not stop the others. If draining takes more than 100 passes,
  `flush()` clears the queue and throws a cycle error; two effects that write each
  other's sources must not hang the device.
- `batch(fn)` increments the depth around `fn` and returns its result; at depth zero
  it asks the scheduler to flush if the queue is non-empty. Nested batches flush once
  at the outermost.
- `setScheduler(s)` installs `s(flush)`, called exactly once when the queue goes from
  empty to non-empty while not inside a batch, and not again until that flush has run.
  `null` means manual: nothing is called and the app runs `flush()` itself. The default
  is the microtask scheduler.

A running computation, a running effect, and a running `flush()` each count as a
batch. The scheduler is only asked once the outermost of them finishes. Without this,
the synchronous scheduler would run effects in the middle of a computation that
wrote a `State`, and any effect reading that computation would hit the cycle error.

Three modes fall out with no app changes:

| mode | install | effect runs |
|---|---|---|
| microtask (default) | nothing | once, after the current task |
| synchronous | `setScheduler(f => f())` | at the end of the outermost write, computation or `batch` |
| manual | `setScheduler(null)` then `flush()` from `timeupdate` or `progress` | once per player tick |

Under the microtask scheduler, an error rethrown by `flush()` is an uncaught
exception in that microtask and reaches `window.onerror` (or `uncaughtException` in
node), the same as a throwing event handler. That is intended; the core does not add
an error hook.

### Watcher

`Signal.subtle.Watcher` keeps the spec API: `watch(...signals)`, `unwatch(...signals)`,
`getPending()`, and a notify callback that runs inside the notification phase with
reads and writes forbidden. A Watcher is a target of each watched signal, so watching
makes that signal live. `getPending()` returns the watched Computeds that are
OUTDATED, in watch order. It stays simple on purpose: with a first-class `effect`,
the Watcher is a spec-compatibility surface, not the primary path.

### Introspection and `subtle`

`introspectSources(sink)` walks the sink's sources list in evaluation order.
`introspectSinks(signal)` walks the targets list, excluding effects (they are not
spec objects). `hasSinks` and `hasSources` are null checks. `untrack(fn)` clears the
tracking context around `fn`. `currentComputed()` returns the tracking context when it
is a Computed, otherwise `undefined`.

### Files

- `src/core.ts`: edges, flags, versions, the four classes, the pending queue,
  `batch`, `flush`, `setScheduler`, `effect`.
- `src/index.ts`: assembles the `Signal` namespace from the classes and exports the
  four functions beside it.
- Removed: `graph.ts`, `computed.ts`, `signal.ts`, `equality.ts`, `errors.ts`,
  `wrapper.ts`. `public-api-types.ts` stays and is updated to import from `index.ts`.
- `tests/benchmarks/adapter.ts` uses the native `effect` and `batch`, and installs the
  synchronous scheduler so effect work stays inside the timed region, the same as the
  preact adapter's `batch`.
- `tests/benchmarks/compare/`: the measurement scripts described below.
- Test imports move from `src/wrapper.js` to `src/index.js`.

### Tests to add

- `effect`: runs at creation, re-runs once per flush regardless of how many sources
  changed, cleanup runs before re-run and on dispose, dispose stops re-runs, an effect
  whose sources were notified but compare equal does not re-run, a throw on first run
  disposes and rethrows, a throwing cleanup disposes.
- Scheduler: default runs after a microtask; synchronous runs at end of write; manual
  runs nothing until `flush()`; `batch` coalesces; nested `batch` flushes once; a write
  inside a computation under the synchronous scheduler flushes after the computation;
  an error in one effect does not prevent others from running and is rethrown; two
  effects that write each other's sources throw the cycle error instead of hanging.
- Liveness through effects: `watched` fires when an effect first reads a signal,
  `unwatched` when the effect is disposed.

Error-path tests install the manual or synchronous scheduler and call `flush()`
themselves, so nothing is thrown from a microtask during a test run.

## Measurement

The evaluation harness was written in a session scratch directory and is not in the
repository. The first task of the build is to check a trimmed copy in under
`tests/benchmarks/compare/`, with `@preact/signals-core` added as a devDependency.
Its current location, which may not survive, is
`/private/tmp/claude-503/-Users-cocch1216-dev-littlespex-signal-polyfill--claude-worktrees-signal-polyfill-bundle-eval-c9cab5/b22073db-bef1-4eac-992c-954b418744ff/scratchpad/peers`
(`measure.sh`, `mem/bench.mjs`, `mem/adapters.mjs`, `perf/run.ts`, `perf/table.cjs`).
The method is simple enough to rebuild from this section if that directory is gone.

Method:

- Size: an entry file that re-exports everything from the package, bundled with
  `esbuild --bundle --format=esm --minify --target=<target>`, then `gzip -9`.
  Target was `es2022` for the baselines; use `es2019` for the rewrite.
- Heap per node: `node --expose-gc`, N = 100,000, one process per library. Create N
  states; then N computeds each reading one state, each read once; then N effects
  each reading one computed. After each stage call `gc()` twice and divide the
  `heapUsed` increase by N.
- Throughput: js-reactivity-benchmark `testFramework` with `testPullCounts: true`, one
  process per library, single run, sum of all test times.

Baselines, 2026-11-09, Node 24, Apple silicon laptop:

| | this branch today | @preact/signals-core 1.14.5 | target for rewrite |
|---|---|---|---|
| min+gzip, full export | 2,543 B | 2,134 B | 2,000 B or less |
| heap: state | 305 B | 298 B | |
| heap: computed | 980 B | 452 B | |
| heap: effect | 2,294 B | 354 B | |
| heap: total per triple | 3,580 B | 1,103 B | 1,434 B or less |
| benchmark total | 32,542 ms | 8,049 ms | 10,464 ms or less |

Preact benchmark breakdown: propagation 1,931 ms, create 100 ms, update 19 ms,
dynamic graphs 5,999 ms. The "this branch today" benchmark number used the old
Watcher-based adapter with a microtask fallback.

## Acceptance

- All existing and new tests pass in node, Chrome and Firefox.
- The dist contains no helper functions and no `#` private syntax.
- The pull request reports the three measurements above next to the baselines. The
  targets are the comparison, not a merge gate.

## Decisions already made

Decided with Casey:

- Rewrite rather than trim or port. This is a littlespex fork; upstream quirks carry
  no weight.
- `effect` is first-class, and scheduling must be swappable so microtask, synchronous
  and event-driven (`timeupdate`, `progress`) flushing can be compared.
- ES2019 build target for now.

Claude's calls, open to change:

- Public classes are the nodes (no wrapper indirection).
- `instanceof` receiver checks.
- Effects run synchronously at creation under every scheduler.
- `effect`, `batch`, `flush`, `setScheduler` are exported beside `Signal`, not inside
  `Signal.subtle`.
- The `subtle` introspection functions stay, since they are cheap with linked edges.
- A running computation, effect or flush counts as a batch.
- Effect error policy as written under "Effects", following preact.
- `flush()` gives up after 100 passes with a cycle error.
- A Computed going live is marked OUTDATED only if the global version moved.
- The benchmark adapter uses the synchronous scheduler.
- The measurement scripts are checked into the repository.

## Left to the builder

- Exact flag bit values, internal class names, and whether effects and watchers share
  a base class.
- Whether `getPending()` filters the sources list or keeps a pending list. Filter is
  fine unless a measurement says otherwise.
- Error message wording.
- How the sources list is walked to produce evaluation order for `introspectSources`.
- Whether the three schedulers ship as named helpers or are documented one-liners.
- Whether `queueMicrotask` gets a `Promise.resolve().then` fallback.

## Amendments from planning

Found while writing the build plan. Where these differ from the text above, these win.

- Internals are not TypeScript-private. `private` members cannot be read by the
  graph functions or by sibling classes, so `src/index.ts` exposes interface types
  that omit the internals. The instance is still the node.
- Watcher callbacks run after the whole graph is marked, not in the middle of
  propagation. A callback that throws would otherwise leave live computeds unmarked
  and stale. All pending callbacks run and the first error is rethrown.
- Within one flush pass, effects subscribed to the same source run in creation
  order. "FIFO" above meant this; it is not strict notification order.
- `setScheduler` asks the new scheduler at once when effects are already pending.
- The core is a port of the algorithm in `@preact/signals-core`, which is MIT
  licensed. `src/core.ts` carries its copyright and permission notice.

## Amendments from execution

Decided while building. Where these differ from the text above, these win.

- Goal 4 has one exception. Two assertions in `tests/Signal/ported/vue.test.ts` now
  expect Vue's own values (`'1foo'` and `'1,0'`). The old values pinned an artifact of
  the Angular graph: a Computed counted as clean at the end of its own evaluation even
  when a nested computed had written one of its sources. Keeping that needed three
  special cases and still left watched and unwatched computeds disagreeing.
  `Computed._refresh` follows the reference order with no exceptions.
- Effect order is narrower than "creation order". When a signal is written, the
  effects that read it directly run in the order they subscribed. Order is otherwise
  unspecified: across effects that reach the signal through different computeds, and
  across several writes before one flush. Strict creation order would cost a field per effect and a
  sort per flush pass.
- `flush()` does nothing while a Watcher notify callback is running. The write that
  triggered the callback asks the scheduler again afterwards.
- A scheduler that throws does not stop later flushes: the request flag is reset and
  the error propagates from the call that asked.
- Goal 6 is missed. The core and shell are well over 450 lines excluding comments; the
  measured count is in `tests/benchmarks/compare/README.md`. The 450 figure was an
  estimate made before the port; the reference implements the same features in a
  similar number of lines.
- Measured after the final fix wave (method and per-run figures in
  `tests/benchmarks/compare/README.md`): the bundle is 3,071 B min+gzip, or 2,327 B
  without the license notice, so the size target of goal 5 is missed either way. Heap
  is 1,060 B per state, computed and effect against 1,084 B for preact, so that
  target is met. The benchmark median of five alternating runs is 11,258 ms against
  8,192 ms for preact, a ratio of 1.37, so the 1.3x target is missed. The core and
  shell have 750 non-comment lines, the same as the reference by the `grep` count, so
  goal 6 stays missed.
- `Computed._refresh` is split in two for V8's inlining budget. `_refresh` keeps the
  fast checks, and `_recompute` holds the source check and the recompute. Behavior is
  unchanged: the steps keep the reference order, and the batch depth (an addition for
  the synchronous scheduler) is still held from the source check until RUNNING is
  cleared. `_refresh` raises it only when it is zero.
- `addDependency` differs from the reference in one way: a second read of the same
  signal in one evaluation returns the existing edge, so the edge holds the version of
  the last read. `tests/behaviors/prohibited-contexts.test.ts` ("allows writes during
  computed") depends on it. "Follows the reference order with no exceptions" above
  applies to `_refresh`, not to the whole port.
- A `watched` or `unwatched` hook that throws leaves the graph in an undefined state.
  The README documents this; the core does not contain it. A `null` hook is ignored.
- The public `State`, `Computed` and `Watcher` interfaces carry type-only brands, so
  they are nominal: a State does not type-check as a Computed, as a sink, or as a
  Watcher argument. The brands add nothing to `dist/index.js`.
- The effect order guarantee covers effects that read the written signal only
  directly. An effect that also reaches it through a computed is queued when that
  computed is notified, so it can run after an effect that subscribed to the signal
  later.
