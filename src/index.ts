import * as core from './core.js';

// Effects and their scheduling are not part of the proposal, so they sit
// beside the Signal namespace rather than in it.
export {batch, effect, flush, setScheduler, type Scheduler} from './core.js';

// The core classes are the graph nodes. Their internals cannot be
// TypeScript-private, because the graph functions and the sibling classes read
// them, so the public types are interfaces that leave the internals out.
export namespace Signal {
  // A read-write Signal.
  export interface State<T> {
    get(): T;
    set(value: T): void;
  }
  export const State: {
    new <T>(initialValue: T, options?: Options<T>): State<T>;
    prototype: State<any>;
  } = core.State;

  // A Signal which is a formula based on other Signals.
  export interface Computed<T> {
    get(): T;
  }
  export const Computed: {
    new <T>(computation: () => T, options?: Options<T>): Computed<T>;
    prototype: Computed<any>;
  } = core.Computed;

  export const isState = core.isState;
  export const isComputed = core.isComputed;
  export const isWatcher = core.isWatcher;

  type AnySignal<T = any> = State<T> | Computed<T>;
  type AnySink = Computed<any> | subtle.Watcher;

  export namespace subtle {
    // Runs a callback with all tracking disabled, even for nested Computeds.
    export const untrack: <T>(cb: () => T) => T = core.untrack;

    export const currentComputed: () => Computed<any> | undefined = core.currentComputed;

    // The signals this sink read during its last evaluation, in order.
    export const introspectSources = core.introspectSources as (sink: AnySink) => AnySignal[];

    // The live Computeds and Watchers that depend on this signal.
    export const introspectSinks = core.introspectSinks as (signal: AnySignal) => AnySink[];

    // True iff anything depends on this signal live. That includes effects,
    // which introspectSinks() leaves out.
    export const hasSinks: (signal: AnySignal) => boolean = core.hasSinks;

    // True iff introspectSources() is non-empty.
    export const hasSources: (signal: AnySink) => boolean = core.hasSources;

    export interface Watcher {
      // Adds these signals to the watched set and lets the notify callback run
      // again on the next change. Can be called with no arguments for the latter.
      watch(...signals: AnySignal[]): void;
      unwatch(...signals: AnySignal[]): void;
      // The watched Computeds that have not been re-read since they changed.
      getPending(): Computed<any>[];
    }
    // The notify callback runs at most once between two `watch` calls, inside
    // the write that caused it. No signal may be read or written while it runs.
    export const Watcher: {
      new (notify: (this: Watcher) => void): Watcher;
      prototype: Watcher;
    } = core.Watcher;

    // Hooks to observe being watched or no longer watched.
    export const watched: typeof core.WATCHED = core.WATCHED;
    export const unwatched: typeof core.UNWATCHED = core.UNWATCHED;
  }

  export interface Options<T> {
    // Custom comparison between the old and new value, called with the signal
    // as `this`. Default: Object.is.
    equals?: (this: AnySignal<T>, t: T, t2: T) => boolean;

    // Called when hasSinks becomes true, if it was previously false.
    [Signal.subtle.watched]?: (this: AnySignal<T>) => void;

    // Called when hasSinks becomes false, if it was previously true.
    [Signal.subtle.unwatched]?: (this: AnySignal<T>) => void;
  }
}
