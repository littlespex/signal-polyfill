import {describe, expect, it} from 'vitest';
import {Signal} from '../../src/wrapper.js';

// This file holds one test on purpose. The failure it guards against needs a
// stack overflow to be the first time the graph drops a source in this
// process: the engine then has to compile that code path with almost no stack
// left. Another test in the same file would warm the path up.

describe('Stack overflow while an unwatched chain reruns', () => {
  it('leaves source lists and values right for later runs', () => {
    const N = 120_000;
    const flip = new Signal.State(0);
    const bottom = new Signal.State(1);
    // Which sources a level reads, and in which order. A plain variable, not a
    // signal: the levels rerun because `flip` changes.
    //   0: flip, below, own     1: flip, below     2: below, flip, own
    let phase = 0;
    const chain: Signal.Computed<number>[] = [];
    const lastReads: object[][] = [];
    for (let i = 0; i < N; i++) {
      const own = new Signal.State(0);
      const below = i === 0 ? bottom : chain[i - 1];
      chain.push(
        new Signal.Computed(() => {
          const reads: object[] = (lastReads[i] = []);
          let value = 0;
          if (phase === 2) {
            value += below.get();
            reads.push(below);
          }
          value += flip.get();
          reads.push(flip);
          if (phase !== 2) {
            value += below.get();
            reads.push(below);
          }
          if (phase !== 1) {
            value += own.get();
            reads.push(own);
          }
          return value;
        }),
      );
    }
    const read = (i: number): number | undefined => {
      try {
        return chain[i].get();
      } catch {
        return undefined;
      }
    };
    const readAll = () => {
      for (let i = 0; i < N; i++) read(i);
    };

    // Bottom up, so no read nests deeply. Then one read from the top, which
    // has to rerun every level and runs out of stack.
    readAll();
    flip.set(1);
    // A RangeError in V8. Other engines have their own error for this.
    expect(() => chain[N - 1].get()).toThrow();

    phase = 1; // every level drops its own State
    flip.set(2);
    readAll();
    phase = 2; // and reads it again, after the level below and `flip`
    flip.set(3);
    readAll();

    // Every signal that the last run of a level read is one of its sources.
    const values = chain.map((_, i) => read(i));
    let missing = 0;
    for (let i = 0; i < N; i++) {
      if (values[i] === undefined) continue;
      const sources = Signal.subtle.introspectSources(chain[i]);
      if (lastReads[i].some((signal) => !sources.includes(signal as never))) missing++;
    }
    expect(missing).toBe(0);

    // A change at the bottom reaches every level below the first one that throws.
    bottom.set(1001);
    let stale = 0;
    for (let i = 0; i < N && values[i] !== undefined; i++) {
      if (read(i) !== values[i]! + 1000) stale++;
    }
    expect(values[0]).toBeDefined();
    expect(stale).toBe(0);
  }, 120_000);
});
