import {describe, expect, it} from 'vitest';
import {Signal} from '../../src/wrapper.js';

/**
 * Random graphs and random operations, checked against a model that recomputes
 * every value from scratch. The model knows nothing about caching, liveness or
 * versions, so any stale read or lost notification shows up as a mismatch.
 */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Formula =
  | {kind: 'sum'; deps: number[]}
  // Reads `then` or `otherwise` depending on the parity of `cond`: a dynamic dependency.
  | {kind: 'branch'; cond: number; then: number; otherwise: number}
  // Collapses many inputs to few outputs, so recomputes often produce an equal value.
  | {kind: 'clamp'; dep: number};

const STATES = 6;
const COMPUTEDS = 14;
const WATCHERS = 2;

function run(seed: number, steps: number) {
  const random = mulberry32(seed);
  const int = (n: number) => Math.floor(random() * n);

  // Node i < STATES is a State; the rest are Computeds that only read lower indices.
  const values: number[] = Array.from({length: STATES}, () => int(4));
  const formulas: Formula[] = [];
  for (let i = STATES; i < STATES + COMPUTEDS; i++) {
    const pick = () => int(i);
    const kind = int(3);
    if (kind === 0) {
      formulas.push({kind: 'sum', deps: Array.from({length: 1 + int(3)}, pick)});
    } else if (kind === 1) {
      formulas.push({kind: 'branch', cond: pick(), then: pick(), otherwise: pick()});
    } else {
      formulas.push({kind: 'clamp', dep: pick()});
    }
  }

  const model = (i: number): number => {
    if (i < STATES) return values[i];
    const f = formulas[i - STATES];
    if (f.kind === 'sum') return f.deps.reduce((total, d) => total + model(d), 0);
    if (f.kind === 'branch') return model(f.cond) % 2 === 0 ? model(f.then) : model(f.otherwise);
    return Math.min(model(f.dep), 2);
  };

  const nodes: {get(): number}[] = [];
  const states: Signal.State<number>[] = [];
  for (let i = 0; i < STATES; i++) {
    const s = new Signal.State(values[i]);
    states.push(s);
    nodes.push(s);
  }
  const computeds: Signal.Computed<number>[] = [];
  for (const f of formulas) {
    const c = new Signal.Computed<number>(() => {
      if (f.kind === 'sum') return f.deps.reduce((total, d) => total + nodes[d].get(), 0);
      if (f.kind === 'branch') {
        return nodes[f.cond].get() % 2 === 0 ? nodes[f.then].get() : nodes[f.otherwise].get();
      }
      return Math.min(nodes[f.dep].get(), 2);
    });
    computeds.push(c);
    nodes.push(c);
  }

  const watchers = Array.from({length: WATCHERS}, () => {
    const state = {notified: 0, armed: false, watched: new Set<number>()};
    const watcher = new Signal.subtle.Watcher(() => {
      state.notified++;
    });
    return {watcher, state};
  });

  // fresh[i]: computed i was read after the last effective set, so its recorded
  // sources and cached value are current.
  const fresh: boolean[] = Array(COMPUTEDS).fill(false);
  const read = (i: number, context: string) => {
    expect(computeds[i].get(), `${context}: computed ${i}`).toBe(model(STATES + i));
    fresh[i] = true;
  };

  for (let step = 0; step < steps; step++) {
    const context = `seed ${seed} step ${step}`;
    const op = int(10);

    if (op < 4) {
      // Set a State and check who must hear about it.
      const i = int(STATES);
      const next = int(4);
      const before = computeds.map((_, c) => model(STATES + c));
      const counts = watchers.map((w) => w.state.notified);
      const changed = values[i] !== next;
      values[i] = next;
      states[i].set(next);

      watchers.forEach(({watcher, state}, index) => {
        const pending = watcher.getPending();
        let mustNotify = false;
        for (const c of state.watched) {
          if (fresh[c] && before[c] !== model(STATES + c)) {
            mustNotify = true;
            expect(pending, `${context}: computed ${c} pending`).toContain(computeds[c]);
          }
        }
        const delta = state.notified - counts[index];
        expect(delta, `${context}: notify count`).toBeLessThanOrEqual(1);
        if (!state.armed) expect(delta, `${context}: notify while not armed`).toBe(0);
        if (mustNotify && state.armed) expect(delta, `${context}: missing notify`).toBe(1);
        if (delta === 1) state.armed = false;
      });
      if (changed) fresh.fill(false);
    } else if (op < 7) {
      read(int(COMPUTEDS), context);
    } else if (op === 7) {
      // Watch a computed (possibly one that was never read, or is stale).
      const {watcher, state} = watchers[int(WATCHERS)];
      const c = int(COMPUTEDS);
      watcher.watch(computeds[c]);
      state.watched.add(c);
      state.armed = true;
    } else if (op === 8) {
      const {watcher, state} = watchers[int(WATCHERS)];
      const all = [...state.watched];
      if (all.length > 0) {
        const c = all[int(all.length)];
        watcher.unwatch(computeds[c]);
        state.watched.delete(c);
      }
    } else {
      // Flush one watcher the way an effect scheduler would.
      const {watcher, state} = watchers[int(WATCHERS)];
      for (const c of watcher.getPending()) {
        read(computeds.indexOf(c as Signal.Computed<number>), context);
      }
      expect(watcher.getPending(), `${context}: pending after flush`).toStrictEqual([]);
      watcher.watch();
      state.armed = true;
    }
  }

  // Everything agrees with the model at the end, and liveness is consistent.
  for (let i = 0; i < COMPUTEDS; i++) read(i, `seed ${seed} final`);
  for (const {watcher, state} of watchers) {
    watcher.unwatch(...[...state.watched].map((c) => computeds[c]));
  }
  for (const s of states) expect(Signal.subtle.hasSinks(s)).toBe(false);
  for (const c of computeds) expect(Signal.subtle.hasSinks(c)).toBe(false);
}

describe('Fuzz against a recompute-everything model', () => {
  it('agrees on values, pending lists and notifications', () => {
    for (let seed = 1; seed <= 150; seed++) run(seed, 400);
  });
});
