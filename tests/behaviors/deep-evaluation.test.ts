import {describe, expect, it} from 'vitest';
import {Signal} from '../../src/wrapper.js';

// `refresh` checks a computed's sources and runs its callback in one function,
// with few locals, so that a chain of computeds can be long before the stack
// runs out. These tests pin what that function must still do at its edges.
describe('Deep and repeated evaluation', () => {
  function chainOf(n: number) {
    const s = new Signal.State(0);
    const chain: Signal.Computed<number>[] = [];
    let prev: {get(): number} = s;
    for (let i = 0; i < n; i++) {
      const source = prev;
      const c = new Signal.Computed(() => source.get() + 1);
      chain.push(c);
      prev = c;
    }
    return {s, chain, top: chain[n - 1]};
  }

  // Reads every computed, shallowest first, and counts the outcomes.
  function survey(chain: Signal.Computed<number>[], base: number) {
    const counts: Record<string, number> = {};
    for (let i = 0; i < chain.length; i++) {
      let key: string;
      try {
        key = chain[i].get() === base + i + 1 ? 'ok' : 'wrong value';
      } catch (e) {
        key = (e as Error).message;
      }
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  for (const live of [false, true]) {
    it(`a first read that overflows the stack leaves nothing busy or frozen (live=${live})`, () => {
      // Far deeper than any stack: the first read of the top recurses once per level.
      const N = 100_000;
      const {s, chain, top} = chainOf(N);
      const w = new Signal.subtle.Watcher(() => {});
      if (live) w.watch(top);

      // A RangeError in V8. Other engines have their own error for this.
      expect(() => top.get()).toThrow();
      expect(Signal.subtle.currentComputed()).toBe(undefined);
      expect(() => s.get()).not.toThrow();

      // A computed whose callback overflowed before it read anything has no
      // sources and keeps its RangeError, and so do the ones above it. What
      // must not happen is a cycle error (nothing here is cyclic, so it could
      // only come from a computed left busy), a "frozen" error or a wrong value.
      s.set(1);
      const after = survey(chain, 1);
      expect(Object.keys(after).filter((k) => /cycle/i.test(k))).toStrictEqual([]);
      expect(
        Object.keys(after).filter((k) => /notify, watched or unwatched/.test(k)),
      ).toStrictEqual([]);
      expect(after['wrong value']).toBe(undefined);
      expect(after.ok).toBeGreaterThan(0);
      if (live) w.unwatch(top);
    });
  }

  it('checks the sources again at most 100 times while callbacks keep setting States', () => {
    // `a` and `b` chase each other: each rerun of `left` sets `b`, each rerun
    // of `right` sets `a`. Both always return 0, so `top` never has to rerun,
    // but no check of its sources ends without a set.
    const a = new Signal.State(0);
    const b = new Signal.State(0);
    let chasing = false;
    let leftRuns = 0;
    let rightRuns = 0;
    let topRuns = 0;
    const left = new Signal.Computed(() => {
      leftRuns++;
      const v = a.get();
      if (chasing) b.set(v + 1);
      return 0;
    });
    const right = new Signal.Computed(() => {
      rightRuns++;
      const v = b.get();
      if (chasing) a.set(v + 1);
      return 0;
    });
    const top = new Signal.Computed(() => {
      topRuns++;
      return left.get() + right.get();
    });
    expect(top.get()).toBe(0);
    expect([leftRuns, rightRuns, topRuns]).toStrictEqual([1, 1, 1]);

    chasing = true;
    a.set(1);
    expect(top.get()).toBe(0);
    // The first check and 100 more.
    expect([leftRuns - 1, rightRuns - 1, topRuns]).toStrictEqual([101, 101, 1]);

    // The value is not trusted beyond that read: the next one checks again.
    // `left` reruns because the last run of `right` set `a`; it sets nothing
    // now, so `right` is clean and the check ends.
    chasing = false;
    expect(top.get()).toBe(0);
    expect([leftRuns - 1, rightRuns - 1, topRuns]).toStrictEqual([102, 101, 1]);
    expect(top.get()).toBe(0);
    expect([leftRuns - 1, rightRuns - 1, topRuns]).toStrictEqual([102, 101, 1]);
  });

  for (const live of [false, true]) {
    it(`drops several sources in one rerun, at both ends of the list (live=${live})`, () => {
      const unwatched: string[] = [];
      const watched: string[] = [];
      const state = (name: string) =>
        new Signal.State(name, {
          [Signal.subtle.watched]: () => void watched.push(name),
          [Signal.subtle.unwatched]: () => void unwatched.push(name),
        });
      const mode = new Signal.State('all');
      const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(state);
      const pick: Record<string, Signal.State<string>[]> = {
        all: [a, b, c, d, e],
        middle: [c],
        ends: [a, e],
        none: [],
      };
      const joined = new Signal.Computed(() => {
        const m = mode.get();
        return pick[m].map((s) => s.get()).join('');
      });
      const w = new Signal.subtle.Watcher(() => {});
      if (live) w.watch(joined);
      const sources = () => Signal.subtle.introspectSources(joined);
      const step = (m: string) => {
        watched.length = unwatched.length = 0;
        mode.set(m);
        const value = joined.get();
        return live ? {value, watched: [...watched], unwatched: [...unwatched]} : {value};
      };
      const hooks = (w: string[], u: string[]) => (live ? {watched: w, unwatched: u} : {});

      expect(joined.get()).toBe('abcde');
      expect(sources()).toStrictEqual([mode, a, b, c, d, e]);

      expect(step('middle')).toStrictEqual({value: 'c', ...hooks([], ['a', 'b', 'd', 'e'])});
      expect(sources()).toStrictEqual([mode, c]);

      expect(step('all')).toStrictEqual({value: 'abcde', ...hooks(['a', 'b', 'd', 'e'], [])});
      expect(sources()).toStrictEqual([mode, a, b, c, d, e]);

      expect(step('ends')).toStrictEqual({value: 'ae', ...hooks([], ['b', 'c', 'd'])});
      expect(sources()).toStrictEqual([mode, a, e]);

      expect(step('none')).toStrictEqual({value: '', ...hooks([], ['a', 'e'])});
      expect(sources()).toStrictEqual([mode]);

      expect(step('all')).toStrictEqual({value: 'abcde', ...hooks(['a', 'b', 'c', 'd', 'e'], [])});
      expect(sources()).toStrictEqual([mode, a, b, c, d, e]);
      for (const s of [a, b, c, d, e]) expect(Signal.subtle.hasSinks(s)).toBe(live);

      // The list is still sound: a change to any of them reaches the computed.
      e.set('E');
      expect(joined.get()).toBe('abcdE');
      a.set('A');
      expect(joined.get()).toBe('AbcdE');
    });
  }
});
