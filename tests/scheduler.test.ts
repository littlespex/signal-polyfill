import {describe, expect, it, vi} from 'vitest';
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
});
