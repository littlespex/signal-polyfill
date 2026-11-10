import {afterEach, describe, expect, it, vi} from 'vitest';
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

  it('a scheduler that throws is asked again on the next write', () => {
    let fail = true;
    const scheduler = vi.fn((f: () => void) => {
      if (fail) throw new Error('scheduler');
      f();
    });
    setScheduler(scheduler);
    const {a, fn} = counted();
    expect(() => a.set(1)).toThrowError('scheduler');
    expect(fn).toHaveBeenCalledTimes(1);
    fail = false;
    a.set(2);
    expect(scheduler).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a scheduled flush called from a Watcher callback is not lost', () => {
    const parked: Array<() => void> = [];
    const scheduler = vi.fn((f: () => void) => void parked.push(f));
    const drain = () => parked.splice(0).forEach((f) => f());
    setScheduler(scheduler);
    const {a, b, fn} = counted();
    a.set(1);
    expect(scheduler).toHaveBeenCalledTimes(1);
    const w = new Signal.subtle.Watcher(drain);
    w.watch(b);
    b.set(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(scheduler).toHaveBeenCalledTimes(2);
    drain();
    expect(fn).toHaveBeenCalledTimes(2);
    w.unwatch(b);
  });
});

describe('synchronous scheduler', () => {
  afterEach(() => setScheduler(null));

  it('a source recomputed during a source check can write a State an effect reads', () => {
    setScheduler(sync);
    const src = new Signal.State(1);
    const out = new Signal.State(0);
    const inner = new Signal.Computed(() => {
      out.set(src.get() * 2);
      return src.get();
    });
    const outer = new Signal.Computed(() => inner.get() + 1);
    expect(outer.get()).toBe(2);
    const seen: number[][] = [];
    effect(() => void seen.push([out.get(), Signal.subtle.untrack(() => outer.get())]));
    src.set(5);
    expect(outer.get()).toBe(6);
    expect(seen).toEqual([
      [2, 2],
      [10, 6],
    ]);
  });

  it("throws an effect's error from set()", () => {
    setScheduler(sync);
    const s = new Signal.State(0);
    effect(() => {
      if (s.get() === 1) throw new Error('boom');
    });
    expect(() => s.set(1)).toThrowError('boom');
  });

  it('effect() disposes the new effect when another effect fails in the flush after its first run', () => {
    setScheduler(sync);
    const s = new Signal.State(0);
    const other = new Signal.State(0);
    effect(() => {
      if (s.get() === 1) throw new Error('other effect');
    });
    const fn = vi.fn(() => {
      other.get();
      s.set(1);
    });
    expect(() => effect(fn)).toThrowError('other effect');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(Signal.subtle.hasSinks(other)).toBe(false);
  });
});
