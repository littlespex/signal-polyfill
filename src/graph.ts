/**
 * The reactive graph behind `Signal.State`, `Signal.Computed` and
 * `Signal.subtle.Watcher`, written from the "Signal algorithms" section of the
 * TC39 Signals proposal.
 *
 * Two rules from that text shape everything here:
 *
 * 1. A signal's `sinks` holds only watched signals ("We do not add `computing`
 *    to this Signal's `sinks` set until it is watched by a Watcher"). So a
 *    source never references a computed that nobody watches, and that computed
 *    can be garbage collected while its sources live on.
 * 2. `State.set` can therefore reach watched computeds only. They are marked
 *    by a walk over sink lists (the STALE flag). Unwatched computeds find out
 *    on their next read, by comparing version numbers (the text's "generation
 *    numbers").
 *
 * Every edge is one `Link`. It is always on its sink's ordered source list,
 * and on its source's sink list only while the sink is live (watched, directly
 * or through other computeds).
 *
 * Departures from the text, each pinned by a test:
 *
 * - `Computed.get` step 4 recalculates every stale source before the reader.
 *   Here the reader reruns as soon as one source has changed, and later
 *   sources are refreshed when the callback reads them (`refresh`). This is
 *   what the Solid-derived tests in tests/behaviors/graph.test.ts expect.
 * - `State.set` step 4 dirties a direct sink only "if previously clean", which
 *   leaves an already-marked computed with a stale value. Staleness is decided
 *   by comparing versions per edge instead, so one STALE flag is enough.
 * - "Recalculate" step 1 clears the sources before the run. Here links are
 *   kept, and the ones not read again are dropped after the run, so a source
 *   that stays in use sees no `unwatched`/`watched` pair (`recompute`).
 * - `equals` runs while `computing` is still the computed, so signals it reads
 *   become that computed's sources. A State's `equals` that throws makes
 *   `set` throw and leaves the value unchanged.
 * - `watched`/`unwatched` fire for every signal whose liveness flips, sources
 *   first. Their errors are thrown from `watch`/`unwatch` after the graph work
 *   is done, or become the value of the computed whose run caused the flip.
 * - `getPending` reads "dirty or pending" as "may be out of date". "Recalculate"
 *   steps 8 and 9 (push dirty to sinks, clean up checked sinks) are replaced
 *   by the version compare on the next read, so a computed stays pending until
 *   it is read even when its sources turn out unchanged.
 * - `Computed.get` records the read (step 2) after bringing the computed up to
 *   date (step 4), so that the recorded version is the one that was returned.
 * - A computed whose callback wrote a State, directly or through a computed it
 *   read, ends its run clean in the text. Here it keeps its value until the
 *   next set anywhere, and is then checked again together with its readers
 *   (UNSETTLED). Until that check a reader can hold a value that predates the
 *   write, as in the text.
 * - `currentComputed()` returns `undefined`, not `null`, when nothing is
 *   computing: tests/Signal/subtle/currentComputed.test.ts expects that.
 */

/** Live computed only: a (recursive) source was set since the last validation. */
const STALE = 1 << 0;
/** The computed is being validated or its callback is running. Reading it now is a cycle. */
const COMPUTING = 1 << 1;
/** Computed only: its source links are on their sources' sink lists. */
const LIVE = 1 << 2;
/** `value` holds a thrown exception, to be rethrown on read. */
const HAS_ERROR = 1 << 3;
export const WATCHER = 1 << 4;
/** Watcher states. Neither bit set is the text's `waiting`. */
const WATCHING = 1 << 5;
const PENDING = 1 << 6;
/**
 * A State was set while the computed last ran, or it read a computed in this
 * state, so its value is trusted for the generation in `validatedAt` only.
 * Unlike STALE it does not make the computed pending, and it applies whether
 * or not the computed is live.
 */
const UNSETTLED = 1 << 7;

/** `Link.version` of a source that the running computed has not read again yet. */
const UNREAD = -1;

type Hook = (this: any) => void;

export interface Node {
  flags: number;
  /** Bumped each time `value` changes. 0 on a computed means "never evaluated". */
  version: number;
  value: unknown;
  /** Computed: the callback. Watcher: `notify`. State: undefined. */
  fn: ((this: any) => unknown) | undefined;
  /** The public object, used as `this` for callbacks and returned by introspection. */
  wrapper: object;
  equals: ((this: any, a: any, b: any) => boolean) | undefined;
  watched: Hook | undefined;
  unwatched: Hook | undefined;
  /** Links to live sinks, in the order they attached. */
  sinks: Link | undefined;
  sinksTail: Link | undefined;
  /** Computed: links to the sources read by the last run, in read order. Watcher: watched signals. */
  sources: Link | undefined;
  sourcesTail: Link | undefined;
  /** While a computed that reads this node is running: that computed's link to this node. */
  active: Link | undefined;
  /** Computed: id of the last `State.set` walk that marked it STALE. */
  mark: number;
  /** Computed: the `generation` at which the cached value was last known to be current. */
  validatedAt: number;
}

interface Link {
  source: Node;
  sink: Node;
  /** `source.version` as last seen by `sink`, or UNREAD. */
  version: number;
  prevSource: Link | undefined;
  nextSource: Link | undefined;
  prevSink: Link | undefined;
  nextSink: Link | undefined;
  /** The value of `source.active` to restore when the sink's run ends. */
  rollback: Link | undefined;
}

/** The text's `computing`. */
let computing: Node | undefined;
/** The text's `frozen`. */
let frozen = false;
/** The text's `generation`: counts effective `State.set` calls. */
let generation = 0;
let walkId = 0;
/**
 * A STALE mark from a walk up to this id does not stop a later walk. Raised
 * to `walkId` whenever something below already marked computeds may need to
 * be reached again: a `watch()` call, or a computed that ended a run UNSETTLED.
 */
let armMark = 0;
/** Errors thrown by `watched`/`unwatched` callbacks, waiting for their owner. */
let hookErrors: unknown[] | undefined;
/**
 * While a computed is being validated or run: the earliest `validatedAt` among
 * the UNSETTLED computeds it has read so far, or Infinity if it read none.
 */
let trustLimit = Infinity;
const walkStack: (Link | undefined)[] = [];
const liveStack: (Link | undefined)[] = [];
/** How often `refresh` re-checks sources when callbacks keep setting States while it checks. */
const MAX_RECHECKS = 100;

export function createNode(
  flags: number,
  value: unknown,
  fn: ((this: any) => unknown) | undefined,
  wrapper: object,
): Node {
  // One literal, one field order: every node shares a hidden class.
  return {
    flags,
    version: 0,
    value,
    fn,
    wrapper,
    equals: undefined,
    watched: undefined,
    unwatched: undefined,
    sinks: undefined,
    sinksTail: undefined,
    sources: undefined,
    sourcesTail: undefined,
    active: undefined,
    mark: 0,
    validatedAt: -1,
  };
}

export function getComputing(): Node | undefined {
  return computing;
}

export function setComputing(node: Node | undefined): Node | undefined {
  const prev = computing;
  computing = node;
  return prev;
}

export function assertNotFrozen(): void {
  if (frozen) throwFrozen();
}

function throwFrozen(): never {
  throw new Error(
    'Signals cannot be read, written or watched inside a notify, watched or unwatched callback',
  );
}

function takeErrors(errors: unknown[]): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function stateGet(node: Node): unknown {
  if (frozen) throwFrozen();
  track(node);
  return node.value;
}

export function computedGet(node: Node): unknown {
  if (frozen) throwFrozen();
  const flags = node.flags;
  if (flags & COMPUTING) throw new Error('Cycle detected: a Computed read itself while computing');
  // A live computed that is neither STALE nor UNSETTLED is current. Anything
  // else is current only if nothing was set since it was last validated.
  if ((flags & (LIVE | STALE | UNSETTLED)) !== LIVE && node.validatedAt !== generation) {
    refresh(node);
  }
  track(node);
  const after = node.flags;
  if (after & (HAS_ERROR | UNSETTLED)) {
    // Whoever is reading can trust its own result no longer than this value.
    if (after & UNSETTLED && node.validatedAt < trustLimit) trustLimit = node.validatedAt;
    if (after & HAS_ERROR) throw node.value;
  }
  return node.value;
}

/** Records `source` as a source of the running computed, once per run, in read order. */
function track(source: Node): void {
  const sink = computing;
  if (sink !== undefined) {
    const link = source.active;
    if (link !== undefined && link.sink === sink) {
      if (link.version === UNREAD && link.nextSource !== undefined) moveToTail(sink, link);
      link.version = source.version;
    } else {
      addSource(source, sink, link);
    }
  }
}

/** A link kept from the previous run moves behind the ones already read in this run. */
function moveToTail(sink: Node, link: Link): void {
  const prev = link.prevSource;
  const next = link.nextSource!;
  if (prev !== undefined) prev.nextSource = next;
  else sink.sources = next;
  next.prevSource = prev;
  const tail = sink.sourcesTail!;
  tail.nextSource = link;
  link.prevSource = tail;
  link.nextSource = undefined;
  sink.sourcesTail = link;
}

function addSource(source: Node, sink: Node, rollback: Link | undefined): void {
  const tail = sink.sourcesTail;
  const link: Link = {
    source,
    sink,
    version: source.version,
    prevSource: tail,
    nextSource: undefined,
    prevSink: undefined,
    nextSink: undefined,
    rollback,
  };
  if (tail !== undefined) tail.nextSource = link;
  else sink.sources = link;
  sink.sourcesTail = link;
  source.active = link;
  if (sink.flags & LIVE) attach(link);
}

// ---------------------------------------------------------------------------
// Validation and recomputation
// ---------------------------------------------------------------------------

/**
 * Brings a computed up to date. Sources are checked in read order, each one
 * brought up to date first. The computed reruns as soon as one source turns
 * out to have changed; later sources are refreshed when the callback reads
 * them. If no source changed, the cached value stands.
 *
 * A callback that runs along the way may set a State. What this function
 * checked or computed before that set can then be out of date:
 *
 * - If only sources reran, they are checked again at once.
 * - If the node itself reran, it keeps the value it computed (the text has no
 *   computing -> dirty transition, and the Vue-derived tests pin that), but
 *   only for the current generation: it becomes UNSETTLED, so after the next
 *   set anywhere a read checks it again, watched or not.
 * - A computed that read an UNSETTLED one is UNSETTLED too, with the same
 *   limit, so the two are checked again together.
 */
function refresh(node: Node): void {
  // Busy for the whole check, not only while the callback runs: a source that
  // reads this node back at any point is a cycle.
  node.flags |= COMPUTING;
  const outerLimit = trustLimit;
  let settled = false;
  try {
    for (let pass = 0; ; pass++) {
      const start = generation;
      trustLimit = Infinity;
      let dirty = node.version === 0;
      for (let link = node.sources; !dirty && link !== undefined; link = link.nextSource) {
        const source = link.source;
        if (source.fn !== undefined) {
          const flags = source.flags;
          // A busy source means a cycle: rerun, so that the read throws.
          if (flags & COMPUTING) dirty = true;
          else {
            if (
              (flags & (LIVE | STALE | UNSETTLED)) !== LIVE &&
              source.validatedAt !== generation
            ) {
              refresh(source);
            }
            if (source.flags & UNSETTLED && source.validatedAt < trustLimit) {
              trustLimit = source.validatedAt;
            }
          }
        }
        if (link.version !== source.version) dirty = true;
      }
      if (dirty) recompute(node);
      if (generation === start) {
        // Nothing was set. The result still cannot outlast an UNSETTLED source.
        settled = trustLimit === Infinity;
        break;
      }
      // A State was set during this pass.
      if (dirty || pass === MAX_RECHECKS) break;
    }
    if (settled) {
      node.validatedAt = generation;
      node.flags &= ~(STALE | UNSETTLED);
    } else {
      node.validatedAt = trustLimit < generation ? trustLimit : generation;
      node.flags = (node.flags & ~STALE) | UNSETTLED;
      // This node may sit below computeds that a walk marked during the run.
      // It is not STALE itself, so no walk may stop above it: see `propagate`.
      armMark = walkId;
    }
  } finally {
    // In `finally` so that a stack overflow far below cannot leave the node busy.
    node.flags &= ~COMPUTING;
    trustLimit = outerLimit;
  }
}

function recompute(node: Node): void {
  // Point each source at this node's link so `track` can find it, and mark
  // every link UNREAD. Whatever is still UNREAD afterwards is dropped.
  for (let link = node.sources; link !== undefined; link = link.nextSource) {
    const source = link.source;
    link.rollback = source.active;
    source.active = link;
    link.version = UNREAD;
  }

  const prevComputing = computing;
  const prevHookErrors = hookErrors;
  computing = node;
  hookErrors = undefined;

  let value: unknown;
  let failed = false;
  let changed = true;
  try {
    value = node.fn!.call(node.wrapper);
    // `equals` runs before `computing` is restored, so signals it reads become
    // sources of this computed. It is not called on the first run or when the
    // previous run threw: there is no old value to compare.
    if (node.version !== 0 && !(node.flags & HAS_ERROR)) {
      const equals = node.equals;
      changed = !(equals === undefined
        ? Object.is(node.value, value)
        : equals.call(node.wrapper, node.value, value));
    }
  } catch (error) {
    value = error;
    failed = true;
  }
  computing = prevComputing;

  let link = node.sources;
  while (link !== undefined) {
    const next = link.nextSource;
    link.source.active = link.rollback;
    link.rollback = undefined;
    if (link.version === UNREAD) {
      const prev = link.prevSource;
      if (prev !== undefined) prev.nextSource = next;
      else node.sources = next;
      if (next !== undefined) next.prevSource = prev;
      else node.sourcesTail = prev;
      if (node.flags & LIVE) detach(link);
    }
    link = next;
  }

  // A `watched`/`unwatched` callback that threw because of this run's reads
  // becomes the computed's value, like any other error raised by the run.
  if (hookErrors !== undefined) {
    value = takeErrors(hookErrors);
    failed = true;
    changed = true;
  }
  hookErrors = prevHookErrors;

  node.flags = failed ? node.flags | HAS_ERROR : node.flags & ~HAS_ERROR;
  if (changed) {
    node.value = value;
    node.version++;
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export function stateSet(node: Node, value: unknown): void {
  if (frozen) throwFrozen();
  const equals = node.equals;
  if (
    equals === undefined
      ? Object.is(node.value, value)
      : equals.call(node.wrapper, node.value, value)
  ) {
    return;
  }
  node.value = value;
  node.version++;
  generation++;
  if (node.sinks !== undefined) propagate(node);
}

/**
 * Marks every live computed downstream of `source` STALE and collects the
 * Watchers that are `watching`. Their `notify` callbacks run after the walk,
 * so they never see a half-marked graph.
 *
 * The walk does not go below a computed that is already STALE if a recent
 * enough walk marked it (`mark > armMark`): everything below it is marked too,
 * and no Watcher below it has been armed since. An older mark does not stop
 * the walk, because a Watcher below may have been re-armed and must hear
 * about this set.
 */
function propagate(source: Node): void {
  const id = ++walkId;
  let queue: Node[] | undefined;
  let top = 0;
  let link: Link | undefined = source.sinks;
  for (;;) {
    while (link !== undefined) {
      const sink = link.sink;
      link = link.nextSink;
      const flags = sink.flags;
      if (flags & WATCHER) {
        if (flags & WATCHING) {
          sink.flags = flags ^ (WATCHING | PENDING);
          (queue ??= []).push(sink);
        }
      } else if (!(flags & STALE) || sink.mark <= armMark) {
        sink.flags = flags | STALE;
        sink.mark = id;
        if (sink.sinks !== undefined) {
          if (link !== undefined) walkStack[top++] = link;
          link = sink.sinks;
        }
      }
    }
    if (top === 0) break;
    link = walkStack[--top];
    walkStack[top] = undefined;
  }
  if (queue !== undefined) notify(queue);
}

function notify(queue: Node[]): void {
  let errors: unknown[] | undefined;
  for (let i = 0; i < queue.length; i++) {
    const watcher = queue[i];
    frozen = true;
    try {
      watcher.fn!.call(watcher.wrapper);
    } catch (error) {
      (errors ??= []).push(error);
    }
    frozen = false;
    watcher.flags &= ~PENDING;
  }
  if (errors !== undefined) throw takeErrors(errors);
}

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/**
 * Puts `link` on its source's sink list. A source that gains its first sink
 * becomes live, which puts its own source links on their sink lists in turn.
 * `watched` callbacks run once the whole graph is linked, sources first.
 *
 * Iterative, so that the depth of the graph is not limited by the stack.
 */
function attach(root: Link): void {
  let hooks: Node[] | undefined;
  let top = 0;
  let link = root;
  for (;;) {
    const source = link.source;
    const tail = source.sinksTail;
    link.prevSink = tail;
    if (tail !== undefined) {
      tail.nextSink = link;
      source.sinksTail = link;
    } else {
      source.sinks = source.sinksTail = link;
      if (source.fn !== undefined) {
        // From here on `State.set` reaches this computed, but sets that
        // happened while it was not live did not. Unless it was validated in
        // this very generation, it has to be checked on its next read. No
        // walk has covered what is below it now, hence the reset of `mark`.
        source.flags |= source.validatedAt === generation ? LIVE : LIVE | STALE;
        source.mark = 0;
        const first = source.sources;
        if (first !== undefined) {
          liveStack[top++] = link;
          link = first;
          continue;
        }
      }
      if (source.watched !== undefined) (hooks ??= []).push(source);
    }
    // On to the next source of the computed that is going live or, once its
    // sources are done, back to the link that made it live.
    for (;;) {
      if (top === 0) {
        if (hooks !== undefined) callHooks(hooks, true);
        return;
      }
      const next: Link | undefined = link.nextSource;
      if (next !== undefined) {
        link = next;
        break;
      }
      link = liveStack[--top]!;
      liveStack[top] = undefined;
      if (link.source.watched !== undefined) (hooks ??= []).push(link.source);
    }
  }
}

/**
 * Takes `link` off its source's sink list. A source that loses its last sink
 * stops being live, which takes its own source links off their sink lists in
 * turn. `unwatched` callbacks run once the whole graph is unlinked.
 */
function detach(root: Link): void {
  let hooks: Node[] | undefined;
  let top = 0;
  let link = root;
  for (;;) {
    const source = link.source;
    const prev = link.prevSink;
    const next = link.nextSink;
    if (prev !== undefined) prev.nextSink = next;
    else source.sinks = next;
    if (next !== undefined) next.prevSink = prev;
    else source.sinksTail = prev;
    link.prevSink = link.nextSink = undefined;
    if (source.sinks === undefined) {
      if (source.fn !== undefined) {
        // A live computed without STALE is current as of now. Record that in
        // the form unwatched computeds use.
        if (!(source.flags & (STALE | UNSETTLED))) source.validatedAt = generation;
        source.flags &= ~(LIVE | STALE);
        const first = source.sources;
        if (first !== undefined) {
          liveStack[top++] = link;
          link = first;
          continue;
        }
      }
      if (source.unwatched !== undefined) (hooks ??= []).push(source);
    }
    for (;;) {
      if (top === 0) {
        if (hooks !== undefined) callHooks(hooks, false);
        return;
      }
      const nextSource: Link | undefined = link.nextSource;
      if (nextSource !== undefined) {
        link = nextSource;
        break;
      }
      link = liveStack[--top]!;
      liveStack[top] = undefined;
      if (link.source.unwatched !== undefined) (hooks ??= []).push(link.source);
    }
  }
}

function callHooks(nodes: Node[], watched: boolean): void {
  frozen = true;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    try {
      (watched ? node.watched! : node.unwatched!).call(node.wrapper);
    } catch (error) {
      (hookErrors ??= []).push(error);
    }
  }
  frozen = false;
}

/** Ends a `watch`/`unwatch` call: throws what its own hooks threw, and puts back what was pending before it. */
function finishHooks(outer: unknown[] | undefined): void {
  const errors = hookErrors;
  hookErrors = outer;
  if (errors !== undefined) throw takeErrors(errors);
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

/**
 * A Watcher's link to `source`, if it watches it. The link is on two lists,
 * the signal's sinks and the Watcher's signals. Both are walked in step, so
 * the search costs no more than the shorter one.
 */
function findWatcherLink(source: Node, watcher: Node): Link | undefined {
  let sink = source.sinks;
  let signal = watcher.sources;
  while (sink !== undefined && signal !== undefined) {
    if (sink.sink === watcher) return sink;
    if (signal.source === source) return signal;
    sink = sink.nextSink;
    signal = signal.nextSource;
  }
  return undefined;
}

export function watcherWatch(watcher: Node, signals: readonly Node[]): void {
  const outerErrors = hookErrors;
  hookErrors = undefined;
  for (let i = 0; i < signals.length; i++) {
    const source = signals[i];
    if (findWatcherLink(source, watcher) === undefined) {
      const tail = watcher.sourcesTail;
      const link: Link = {
        source,
        sink: watcher,
        version: 0,
        prevSource: tail,
        nextSource: undefined,
        prevSink: undefined,
        nextSink: undefined,
        rollback: undefined,
      };
      if (tail !== undefined) tail.nextSource = link;
      else watcher.sources = link;
      watcher.sourcesTail = link;
      attach(link);
    }
  }
  if (!(watcher.flags & (WATCHING | PENDING))) watcher.flags |= WATCHING;
  armMark = walkId;
  finishHooks(outerErrors);
}

export function watcherUnwatch(watcher: Node, signals: readonly Node[]): void {
  for (let i = 0; i < signals.length; i++) {
    if (findWatcherLink(signals[i], watcher) === undefined) {
      throw new Error('Called unwatch with a signal that this Watcher is not watching');
    }
  }
  const outerErrors = hookErrors;
  hookErrors = undefined;
  for (let i = 0; i < signals.length; i++) {
    const link = findWatcherLink(signals[i], watcher);
    // Undefined when the same signal was passed twice.
    if (link !== undefined) {
      const prev = link.prevSource;
      const next = link.nextSource;
      if (prev !== undefined) prev.nextSource = next;
      else watcher.sources = next;
      if (next !== undefined) next.prevSource = prev;
      else watcher.sourcesTail = prev;
      detach(link);
    }
  }
  if (watcher.sources === undefined) watcher.flags &= ~WATCHING;
  finishHooks(outerErrors);
}

/** Watched computeds that may be out of date, in watch order. */
export function watcherPending(watcher: Node): object[] {
  const pending: object[] = [];
  for (let link = watcher.sources; link !== undefined; link = link.nextSource) {
    const source = link.source;
    if (source.fn !== undefined && source.flags & STALE) pending.push(source.wrapper);
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

export function sourcesOf(node: Node): object[] {
  const result: object[] = [];
  for (let link = node.sources; link !== undefined; link = link.nextSource) {
    result.push(link.source.wrapper);
  }
  return result;
}

export function sinksOf(node: Node): object[] {
  const result: object[] = [];
  for (let link = node.sinks; link !== undefined; link = link.nextSink) {
    result.push(link.sink.wrapper);
  }
  return result;
}
