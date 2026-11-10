/**
 * @license
 * The signal graph algorithm in this file is adapted from @preact/signals-core
 * (https://github.com/preactjs/signals).
 *
 * Copyright (c) 2022-present Preact Team
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Flags for graph nodes.
const RUNNING = 1 << 0;
const NOTIFIED = 1 << 1;
const OUTDATED = 1 << 2;
const DISPOSED = 1 << 3;
const HAS_ERROR = 1 << 4;
const TRACKING = 1 << 5;

// Option keys for the hooks called when a signal gains its first target and
// when it loses its last one.
export const WATCHED: unique symbol = Symbol('watched');
export const UNWATCHED: unique symbol = Symbol('unwatched');

type Options<T> = {
  equals?: (a: T, b: T) => boolean;
  [WATCHED]?: () => void;
  [UNWATCHED]?: () => void;
};

// One edge per (source, target) pair, linked into the target's sources list
// and, while the target is live, into the source's targets list. It records
// the source version the target last saw, so checking for changes needs no
// copy of the source's value. The version -1 marks an edge from the previous
// evaluation that has not been read again yet.
type Edge = {
  _source: State<any> | Computed<any>;
  _prevSource?: Edge;
  _nextSource?: Edge;
  _target: Computed<any> | Watcher;
  _prevTarget?: Edge;
  _nextTarget?: Edge;
  _version: number;
  // The source's `_node` before this evaluation, restored when it ends.
  _rollbackNode?: Edge;
};

// The Computed currently being evaluated.
let evalContext: Computed<any> | undefined = undefined;

// Bumped on every State change, so a Computed can skip walking its sources
// when nothing at all has changed since its last refresh.
let globalVersion = 0;

// True while Watcher callbacks run. Reading or writing a signal then throws.
let notifying = false;

// Watchers notified by the current write whose callbacks have not run yet.
const notifiedWatchers: Watcher[] = [];

export function untrack<T>(fn: () => T): T {
  const prevContext = evalContext;
  evalContext = undefined;
  try {
    return fn();
  } finally {
    evalContext = prevContext;
  }
}

function addDependency(signal: State<any> | Computed<any>): Edge | undefined {
  if (evalContext === undefined) {
    return undefined;
  }

  let node = signal._node;
  if (node === undefined || node._target !== evalContext) {
    // A new dependency: append an edge at the tail of the sources list.
    node = {
      _version: 0,
      _source: signal,
      _prevSource: evalContext._sources,
      _nextSource: undefined,
      _target: evalContext,
      _prevTarget: undefined,
      _nextTarget: undefined,
      _rollbackNode: node,
    };

    if (evalContext._sources !== undefined) {
      evalContext._sources._nextSource = node;
    }
    evalContext._sources = node;
    signal._node = node;

    // A live target subscribes to a new source as soon as it reads it.
    if (evalContext._flags & TRACKING) {
      signal._subscribe(node);
    }
  } else if (node._version === -1) {
    // A dependency from the previous evaluation: reuse the edge and move it
    // to the tail, so the list stays in order of use.
    node._version = 0;

    if (node._nextSource !== undefined) {
      node._nextSource._prevSource = node._prevSource;

      if (node._prevSource !== undefined) {
        node._prevSource._nextSource = node._nextSource;
      }

      node._prevSource = evalContext._sources;
      node._nextSource = undefined;

      evalContext._sources!._nextSource = node;
      evalContext._sources = node;
    }
  }
  // A source read again in the same evaluation also returns its edge, so the
  // edge holds the version of the last read. A write between two reads would
  // otherwise leave the edge behind and force a needless recompute.
  return node;
}

function needsToRecompute(target: Computed<any>): boolean {
  // Sources are in order of use, so when several have changed, only the first
  // one is refreshed before the target recomputes.
  for (let node = target._sources; node !== undefined; node = node._nextSource) {
    if (
      // Skips the refresh when the source is already known to have changed.
      node._source._version !== node._version ||
      // A source that cannot refresh (a cycle) forces a recompute.
      !node._source._refresh() ||
      node._source._version !== node._version
    ) {
      return true;
    }
  }
  return false;
}

function prepareSources(target: Computed<any>) {
  // Marks every current edge reusable, points each source at its edge so
  // addDependency finds it, and leaves `target._sources` at the tail.
  for (let node = target._sources; node !== undefined; node = node._nextSource) {
    const rollbackNode = node._source._node;
    if (rollbackNode !== undefined) {
      node._rollbackNode = rollbackNode;
    }
    node._source._node = node;
    node._version = -1;

    if (node._nextSource === undefined) {
      target._sources = node;
      break;
    }
  }
}

function cleanupSources(target: Computed<any>) {
  let node = target._sources;
  let head: Edge | undefined = undefined;

  // Walks back from the tail, unsubscribing and unlinking edges that were not
  // read again and restoring each source's previous `_node`.
  while (node !== undefined) {
    const prev = node._prevSource;

    if (node._version === -1) {
      node._source._unsubscribe(node);

      if (prev !== undefined) {
        prev._nextSource = node._nextSource;
      }
      if (node._nextSource !== undefined) {
        node._nextSource._prevSource = prev;
      }
    } else {
      head = node;
    }

    node._source._node = node._rollbackNode;
    if (node._rollbackNode !== undefined) {
      node._rollbackNode = undefined;
    }

    node = prev;
  }

  target._sources = head;
}

// The second phase of a write. Runs the callback of every Watcher the first
// phase notified, with `this` as the watcher. All of them run even if one
// throws, and the first error is rethrown afterwards.
function runWatchers(): void {
  let error: unknown;
  let hasError = false;
  notifying = true;
  try {
    for (const watcher of notifiedWatchers) {
      try {
        watcher._fn.call(watcher);
      } catch (err) {
        if (!hasError) {
          error = err;
          hasError = true;
        }
      }
    }
  } finally {
    notifying = false;
    notifiedWatchers.length = 0;
  }
  if (hasError) {
    throw error;
  }
}

export class State<T> {
  _value: T;
  // Never negative, because edges use -1 as a marker.
  _version: number;
  // The edge for the current evaluation context, if it has read this signal.
  _node?: Edge;
  // Head of the targets list. Defined exactly while the signal is live.
  _targets?: Edge;
  _equals: (a: T, b: T) => boolean;
  _watched?: () => void;
  _unwatched?: () => void;

  constructor(value: T, options?: Options<T>) {
    this._value = value;
    this._version = 0;
    this._node = undefined;
    this._targets = undefined;
    this._equals = options?.equals ?? Object.is;
    this._watched = options?.[WATCHED];
    this._unwatched = options?.[UNWATCHED];
  }

  _refresh(): boolean {
    return true;
  }

  // Computed calls these two through `State.prototype`, as the reference
  // calls its base class.
  _subscribe(this: State<any> | Computed<any>, node: Edge): void {
    const targets = this._targets;
    if (targets !== node && node._prevTarget === undefined) {
      node._nextTarget = targets;
      this._targets = node;

      if (targets !== undefined) {
        targets._prevTarget = node;
      } else if (this._watched !== undefined) {
        untrack(() => this._watched!.call(this));
      }
    }
  }

  _unsubscribe(this: State<any> | Computed<any>, node: Edge): void {
    // An edge can only be in the targets list of a live signal.
    if (this._targets !== undefined) {
      const prev = node._prevTarget;
      const next = node._nextTarget;
      if (prev !== undefined) {
        prev._nextTarget = next;
        node._prevTarget = undefined;
      }

      if (next !== undefined) {
        next._prevTarget = prev;
        node._nextTarget = undefined;
      }

      if (node === this._targets) {
        this._targets = next;
        if (next === undefined && this._unwatched !== undefined) {
          untrack(() => this._unwatched!.call(this));
        }
      }
    }
  }

  get(): T {
    if (!(this instanceof State)) {
      throw new TypeError('Invalid receiver');
    }
    if (notifying) {
      throw new Error('Reads from signals not permitted during Watcher callback');
    }
    const node = addDependency(this);
    if (node !== undefined) {
      node._version = this._version;
    }
    return this._value;
  }

  set(value: T): void {
    if (!(this instanceof State)) {
      throw new TypeError('Invalid receiver');
    }
    if (notifying) {
      throw new Error('Writes to signals not permitted during Watcher callback');
    }
    if (!this._equals(this._value, value)) {
      this._value = value;
      this._version++;
      globalVersion++;

      // The first phase marks the whole graph and runs no user code, so a
      // Watcher callback that throws cannot leave a live Computed unmarked.
      for (let node = this._targets; node !== undefined; node = node._nextTarget) {
        node._target._notify();
      }
      if (notifiedWatchers.length !== 0) {
        runWatchers();
      }
    }
  }
}

export class Computed<T> {
  _fn: () => T;
  // The last value, or the last error when HAS_ERROR is set.
  _value: unknown;
  _version: number;
  _node?: Edge;
  _targets?: Edge;
  // Head of the sources list, or its tail while evaluating.
  _sources?: Edge;
  _globalVersion: number;
  _flags: number;
  _equals: (a: T, b: T) => boolean;
  _watched?: () => void;
  _unwatched?: () => void;

  constructor(fn: () => T, options?: Options<T>) {
    this._fn = fn;
    this._value = undefined;
    this._version = 0;
    this._node = undefined;
    this._targets = undefined;
    this._sources = undefined;
    this._globalVersion = globalVersion - 1;
    this._flags = OUTDATED;
    this._equals = options?.equals ?? Object.is;
    this._watched = options?.[WATCHED];
    this._unwatched = options?.[UNWATCHED];
  }

  _refresh(): boolean {
    this._flags &= ~NOTIFIED;

    if (this._flags & RUNNING) {
      return false;
    }

    // A live Computed that no source has notified cannot have changed.
    if ((this._flags & (OUTDATED | TRACKING)) === TRACKING) {
      return true;
    }
    this._flags &= ~OUTDATED;

    if (this._globalVersion === globalVersion) {
      return true;
    }
    this._globalVersion = globalVersion;

    // Set before checking sources, so a cycle through them is caught.
    this._flags |= RUNNING;
    if (this._version > 0 && !needsToRecompute(this)) {
      this._flags &= ~RUNNING;
      return true;
    }

    const prevContext = evalContext;
    try {
      prepareSources(this);
      evalContext = this;
      const value = this._fn();
      // `_equals` runs as part of the evaluation: signals it reads become
      // sources, and an error it throws is cached like one from `_fn`.
      if (
        this._version === 0 ||
        this._flags & HAS_ERROR ||
        !this._equals(this._value as T, value)
      ) {
        this._value = value;
        this._flags &= ~HAS_ERROR;
        this._version++;
      }
    } catch (err) {
      this._value = err;
      this._flags |= HAS_ERROR;
      this._version++;
    }
    evalContext = prevContext;
    cleanupSources(this);
    this._flags &= ~RUNNING;
    return true;
  }

  _subscribe(node: Edge): void {
    if (this._targets === undefined) {
      // Going live runs no computation. Sources written while this was not
      // live sent it no notification, so it is marked OUTDATED only when some
      // State has changed since its last refresh.
      this._flags |= TRACKING;
      if (this._globalVersion !== globalVersion) {
        this._flags |= OUTDATED;
      }

      for (let node = this._sources; node !== undefined; node = node._nextSource) {
        node._source._subscribe(node);
      }
    }
    State.prototype._subscribe.call(this, node);
  }

  _unsubscribe(node: Edge): void {
    if (this._targets !== undefined) {
      State.prototype._unsubscribe.call(this, node);

      // Losing the last target unsubscribes from the sources too, so an
      // unreferenced subgraph can be garbage collected.
      if (this._targets === undefined) {
        this._flags &= ~TRACKING;

        for (let node = this._sources; node !== undefined; node = node._nextSource) {
          node._source._unsubscribe(node);
        }
      }
    }
  }

  _notify(): void {
    if (!(this._flags & NOTIFIED)) {
      this._flags |= OUTDATED | NOTIFIED;

      for (let node = this._targets; node !== undefined; node = node._nextTarget) {
        node._target._notify();
      }
    }
  }

  get(): T {
    if (!(this instanceof Computed)) {
      throw new TypeError('Invalid receiver');
    }
    if (notifying) {
      throw new Error('Reads from signals not permitted during Watcher callback');
    }
    if (this._flags & RUNNING) {
      throw new Error('Detected cycle in computations.');
    }
    const node = addDependency(this);
    this._refresh();
    if (node !== undefined) {
      node._version = this._version;
    }
    if (this._flags & HAS_ERROR) {
      throw this._value;
    }
    return this._value as T;
  }
}

function checkWatchArguments(watcher: unknown, signals: unknown[]): void {
  if (!(watcher instanceof Watcher)) {
    throw new TypeError('Invalid receiver');
  }
  for (const signal of signals) {
    if (!(signal instanceof State || signal instanceof Computed)) {
      throw new TypeError('Invalid argument');
    }
  }
}

export class Watcher {
  _fn: (this: Watcher) => void;
  // Head and tail of the watched signals list, in watch order.
  _sources?: Edge;
  _tail?: Edge;
  _flags: number;

  constructor(notify: (this: Watcher) => void) {
    this._fn = notify;
    this._sources = undefined;
    this._tail = undefined;
    this._flags = 0;
  }

  _notify(): void {
    if (!(this._flags & NOTIFIED)) {
      this._flags |= NOTIFIED;
      notifiedWatchers.push(this);
    }
  }

  watch(...signals: (State<any> | Computed<any>)[]): void {
    checkWatchArguments(this, signals);
    this._flags &= ~NOTIFIED;
    for (const signal of signals) {
      // A signal's targets list is usually far shorter than the watched list.
      let node = signal._targets;
      while (node !== undefined && node._target !== this) {
        node = node._nextTarget;
      }
      if (node === undefined) {
        node = {
          _version: 0,
          _source: signal,
          _prevSource: this._tail,
          _nextSource: undefined,
          _target: this,
          _prevTarget: undefined,
          _nextTarget: undefined,
          _rollbackNode: undefined,
        };
        if (this._tail !== undefined) {
          this._tail._nextSource = node;
        } else {
          this._sources = node;
        }
        this._tail = node;
        signal._subscribe(node);
      }
    }
  }

  unwatch(...signals: (State<any> | Computed<any>)[]): void {
    checkWatchArguments(this, signals);
    for (const signal of signals) {
      let node = signal._targets;
      while (node !== undefined && node._target !== this) {
        node = node._nextTarget;
      }
      if (node !== undefined) {
        // Unlinked first, so a throwing unwatched hook cannot leave this
        // watcher listing a signal it no longer targets.
        const prev = node._prevSource;
        const next = node._nextSource;
        if (prev !== undefined) {
          prev._nextSource = next;
        } else {
          this._sources = next;
        }
        if (next !== undefined) {
          next._prevSource = prev;
        } else {
          this._tail = prev;
        }
        signal._unsubscribe(node);
      }
    }
  }

  getPending(): Computed<any>[] {
    if (!(this instanceof Watcher)) {
      throw new TypeError('Invalid receiver');
    }
    const pending = [];
    for (let node = this._sources; node !== undefined; node = node._nextSource) {
      const source = node._source;
      if (source instanceof Computed && source._flags & OUTDATED) {
        pending.push(source);
      }
    }
    return pending;
  }
}

export function currentComputed(): Computed<any> | undefined {
  return evalContext instanceof Computed ? evalContext : undefined;
}

export function introspectSources(sink: unknown): unknown[] {
  if (!(sink instanceof Computed || sink instanceof Watcher)) {
    throw new TypeError('Invalid argument');
  }
  const sources = [];
  for (let node = sink._sources; node !== undefined; node = node._nextSource) {
    sources.push(node._source);
  }
  return sources;
}

export function hasSources(sink: unknown): boolean {
  if (!(sink instanceof Computed || sink instanceof Watcher)) {
    throw new TypeError('Invalid argument');
  }
  return sink._sources !== undefined;
}

export function introspectSinks(signal: unknown): unknown[] {
  if (!(signal instanceof State || signal instanceof Computed)) {
    throw new TypeError('Invalid argument');
  }
  // Only spec objects count as sinks. Any other kind of target stays hidden.
  const sinks = [];
  for (let node = signal._targets; node !== undefined; node = node._nextTarget) {
    if (node._target instanceof Computed || node._target instanceof Watcher) {
      sinks.push(node._target);
    }
  }
  return sinks;
}

export function hasSinks(signal: unknown): boolean {
  if (!(signal instanceof State || signal instanceof Computed)) {
    throw new TypeError('Invalid argument');
  }
  return signal._targets !== undefined;
}

export function isState(x: unknown): boolean {
  return x instanceof State;
}

export function isComputed(x: unknown): boolean {
  return x instanceof Computed;
}

export function isWatcher(x: unknown): boolean {
  return x instanceof Watcher;
}
