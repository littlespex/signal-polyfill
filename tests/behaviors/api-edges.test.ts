import {describe, expect, it} from 'vitest';
import {Signal} from '../../src/wrapper.js';

// Edges of the public API that no other test pins.

describe('isState / isComputed / isWatcher', () => {
  const state = new Signal.State(1);
  const computed = new Signal.Computed(() => 1);
  const watcher = new Signal.subtle.Watcher(() => {});

  it('answer false, without throwing, for anything that is not an object', () => {
    const values = [undefined, null, 0, 1, NaN, '', 'state', true, false, 1n, Symbol('s')];
    for (const value of values) {
      expect(Signal.isState(value)).toBe(false);
      expect(Signal.isComputed(value)).toBe(false);
      expect(Signal.isWatcher(value)).toBe(false);
    }
  });

  it('answer false for objects that only look like signals', () => {
    const values = [
      {},
      [],
      () => {},
      function () {},
      Object.create(Signal.State.prototype),
      Object.create(Signal.Computed.prototype),
      Object.create(Signal.subtle.Watcher.prototype),
      new Proxy(state, {}),
      new Proxy(computed, {}),
      new Proxy(watcher, {}),
      Signal.State,
      Signal.State.prototype,
    ];
    for (const value of values) {
      expect(Signal.isState(value)).toBe(false);
      expect(Signal.isComputed(value)).toBe(false);
      expect(Signal.isWatcher(value)).toBe(false);
    }
  });

  it('tell the three kinds apart', () => {
    expect([state, computed, watcher].map(Signal.isState)).toStrictEqual([true, false, false]);
    expect([state, computed, watcher].map(Signal.isComputed)).toStrictEqual([false, true, false]);
    expect([state, computed, watcher].map(Signal.isWatcher)).toStrictEqual([false, false, true]);
  });

  it('accept instances of subclasses', () => {
    class MyState extends Signal.State<number> {}
    class MyComputed extends Signal.Computed<number> {}
    class MyWatcher extends Signal.subtle.Watcher {}
    expect(Signal.isState(new MyState(1))).toBe(true);
    expect(Signal.isComputed(new MyComputed(() => 1))).toBe(true);
    expect(Signal.isWatcher(new MyWatcher(() => {}))).toBe(true);
  });
});

describe('a Watcher link and the tracking of a running computed', () => {
  it('a watched signal read twice in one run is one source', () => {
    const s = new Signal.State(1);
    const w = new Signal.subtle.Watcher(() => {});
    w.watch(s);
    const c = new Signal.Computed(() => s.get() + s.get());
    expect(c.get()).toBe(2);
    expect(Signal.subtle.introspectSources(c)).toStrictEqual([s]);
    s.set(2);
    expect(c.get()).toBe(4);
    expect(Signal.subtle.introspectSources(c)).toStrictEqual([s]);
  });

  it('watching a signal in the middle of a run that already read it', () => {
    const s = new Signal.State(1);
    const t = new Signal.State(10);
    const w = new Signal.subtle.Watcher(() => {});
    let runs = 0;
    const c = new Signal.Computed(() => {
      runs++;
      const first = s.get();
      w.watch(s, t);
      return first + s.get() + t.get() + t.get();
    });
    expect(c.get()).toBe(22);
    expect(Signal.subtle.introspectSources(c)).toStrictEqual([s, t]);
    expect(Signal.subtle.introspectSources(w)).toStrictEqual([s, t]);
    expect(Signal.subtle.introspectSinks(s)).toStrictEqual([w]);
    // The rerun reads the same signals: nothing is added or dropped.
    s.set(2);
    expect(c.get()).toBe(24);
    expect(runs).toBe(2);
    expect(Signal.subtle.introspectSources(c)).toStrictEqual([s, t]);
    expect(Signal.subtle.introspectSources(w)).toStrictEqual([s, t]);
    // Unchanged sources: no rerun.
    expect(c.get()).toBe(24);
    expect(runs).toBe(2);
  });

  it('unwatching a signal in the middle of a run that already read it', () => {
    const s = new Signal.State(1);
    const w = new Signal.subtle.Watcher(() => {});
    w.watch(s);
    const c = new Signal.Computed(() => {
      const first = s.get();
      if (Signal.subtle.hasSinks(s)) w.unwatch(s);
      return first + s.get();
    });
    expect(c.get()).toBe(2);
    expect(Signal.subtle.introspectSources(c)).toStrictEqual([s]);
    expect(Signal.subtle.hasSinks(s)).toBe(false);
    expect(Signal.subtle.hasSources(w)).toBe(false);
    s.set(3);
    expect(c.get()).toBe(6);
    expect(Signal.subtle.introspectSources(c)).toStrictEqual([s]);
  });
});

describe('options', () => {
  it('reads each option once, in the order equals, watched, unwatched', () => {
    const log: string[] = [];
    const options = {
      get equals() {
        log.push('equals');
        return undefined;
      },
      get [Signal.subtle.watched]() {
        log.push('watched');
        return undefined;
      },
      get [Signal.subtle.unwatched]() {
        log.push('unwatched');
        return undefined;
      },
    };
    new Signal.State(1, options);
    new Signal.Computed(() => 1, options);
    expect(log).toStrictEqual(['equals', 'watched', 'unwatched', 'equals', 'watched', 'unwatched']);
  });
});

describe('watch and unwatch in a frozen context', () => {
  it('report the frozen context before looking at the arguments', () => {
    const s = new Signal.State(1);
    const errors: unknown[] = [];
    const w = new Signal.subtle.Watcher(() => {
      for (const call of [
        () => w.watch({} as any),
        () => w.unwatch({} as any),
        () => w.watch(s),
        () => w.unwatch(s),
      ]) {
        try {
          call();
          errors.push('no error');
        } catch (error) {
          errors.push(error);
        }
      }
    });
    w.watch(s);
    s.set(2);
    expect(errors).toHaveLength(4);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TypeError);
    }
    // A wrong receiver is still reported first.
    expect(() => Signal.subtle.Watcher.prototype.watch.call({} as any, s)).toThrowError(TypeError);
  });
});

describe('untrack', () => {
  it('restores the running computed when the callback throws', () => {
    const s = new Signal.State(1);
    const t = new Signal.State(2);
    const c = new Signal.Computed(() => {
      try {
        Signal.subtle.untrack(() => {
          s.get();
          throw new Error('inside');
        });
      } catch {
        // ignored
      }
      expect(Signal.subtle.currentComputed()).toBe(c);
      return t.get();
    });
    expect(c.get()).toBe(2);
    expect(Signal.subtle.introspectSources(c)).toStrictEqual([t]);
    expect(Signal.subtle.currentComputed()).toBe(undefined);
  });
});
