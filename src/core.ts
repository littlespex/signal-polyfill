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

// One edge per (source, target) pair, linked into the target's sources list.
// It records the source version the target last saw, so checking for changes
// needs no copy of the source's value. The version -1 marks an edge from the
// previous evaluation that has not been read again yet.
type Edge = {
  _source: State<any> | Computed<any>;
  _prevSource?: Edge;
  _nextSource?: Edge;
  _target: Computed<any>;
  _version: number;
  // The source's `_node` before this evaluation, restored when it ends.
  _rollbackNode?: Edge;
};

// The Computed currently being evaluated.
let evalContext: Computed<any> | undefined = undefined;

// Bumped on every State change, so a Computed can skip walking its sources
// when nothing at all has changed since its last refresh.
let globalVersion = 0;

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
      _rollbackNode: node,
    };

    if (evalContext._sources !== undefined) {
      evalContext._sources._nextSource = node;
    }
    evalContext._sources = node;
    signal._node = node;
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

  // Walks back from the tail, unlinking edges that were not read again and
  // restoring each source's previous `_node`.
  while (node !== undefined) {
    const prev = node._prevSource;

    if (node._version === -1) {
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

export class State<T> {
  _value: T;
  // Never negative, because edges use -1 as a marker.
  _version: number;
  // The edge for the current evaluation context, if it has read this signal.
  _node?: Edge;
  _equals: (a: T, b: T) => boolean;

  constructor(value: T, options?: {equals?: (a: T, b: T) => boolean}) {
    this._value = value;
    this._version = 0;
    this._node = undefined;
    this._equals = options?.equals ?? Object.is;
  }

  _refresh(): boolean {
    return true;
  }

  get(): T {
    if (!(this instanceof State)) {
      throw new TypeError('Invalid receiver');
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
    if (!this._equals(this._value, value)) {
      this._value = value;
      this._version++;
      globalVersion++;
    }
  }
}

export class Computed<T> {
  _fn: () => T;
  // The last value, or the last error when HAS_ERROR is set.
  _value: unknown;
  _version: number;
  _node?: Edge;
  // Head of the sources list, or its tail while evaluating.
  _sources?: Edge;
  _globalVersion: number;
  _flags: number;
  _equals: (a: T, b: T) => boolean;

  constructor(fn: () => T, options?: {equals?: (a: T, b: T) => boolean}) {
    this._fn = fn;
    this._value = undefined;
    this._version = 0;
    this._node = undefined;
    this._sources = undefined;
    this._globalVersion = globalVersion - 1;
    this._flags = OUTDATED;
    this._equals = options?.equals ?? Object.is;
  }

  _refresh(): boolean {
    if (this._flags & RUNNING) {
      return false;
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
    // The old implementation treated a Computed as clean as of the end of its
    // own evaluation, and two ported Vue tests pin that. The reference keeps
    // the version from before evaluation, so a write made during it would
    // force a recompute on the next read.
    this._globalVersion = globalVersion;
    this._flags &= ~RUNNING;
    return true;
  }

  get(): T {
    if (!(this instanceof Computed)) {
      throw new TypeError('Invalid receiver');
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

export function currentComputed(): Computed<any> | undefined {
  return evalContext instanceof Computed ? evalContext : undefined;
}

export function introspectSources(sink: unknown): unknown[] {
  if (!(sink instanceof Computed)) {
    throw new TypeError('Invalid argument');
  }
  const sources = [];
  for (let node = sink._sources; node !== undefined; node = node._nextSource) {
    sources.push(node._source);
  }
  return sources;
}

export function hasSources(sink: unknown): boolean {
  if (!(sink instanceof Computed)) {
    throw new TypeError('Invalid argument');
  }
  return sink._sources !== undefined;
}

export function isState(x: unknown): boolean {
  return x instanceof State;
}

export function isComputed(x: unknown): boolean {
  return x instanceof Computed;
}
