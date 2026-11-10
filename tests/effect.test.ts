import {beforeEach, describe, expect, it, vi} from 'vitest';
import {Signal, effect, flush, setScheduler} from '../src/index.js';

describe('effect', () => {
  beforeEach(() => setScheduler(null));

  it('runs at creation and again on flush', () => {
    const s = new Signal.State(1);
    const seen: number[] = [];
    effect(() => void seen.push(s.get()));
    expect(seen).toEqual([1]);
    s.set(2);
    expect(seen).toEqual([1]);
    flush();
    expect(seen).toEqual([1, 2]);
  });

  it('runs once per flush however many sources changed', () => {
    const a = new Signal.State(1);
    const b = new Signal.State(2);
    const fn = vi.fn(() => void (a.get(), b.get()));
    effect(fn);
    a.set(10);
    b.set(20);
    a.set(11);
    flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not re-run when its sources end up equal', () => {
    const s = new Signal.State(1);
    const parity = new Signal.Computed(() => s.get() % 2);
    const fn = vi.fn(() => void parity.get());
    effect(fn);
    s.set(3);
    flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs cleanup before each re-run and on dispose', () => {
    const s = new Signal.State(1);
    const log: string[] = [];
    const dispose = effect(() => {
      const v = s.get();
      log.push(`run ${v}`);
      return () => void log.push(`cleanup ${v}`);
    });
    s.set(2);
    flush();
    dispose();
    expect(log).toEqual(['run 1', 'cleanup 1', 'run 2', 'cleanup 2']);
    s.set(3);
    flush();
    expect(log).toHaveLength(4);
  });

  it('makes its sources live and is hidden from introspectSinks', () => {
    const watched = vi.fn();
    const unwatched = vi.fn();
    const s = new Signal.State(1, {
      [Signal.subtle.watched]: watched,
      [Signal.subtle.unwatched]: unwatched,
    });
    const dispose = effect(() => void s.get());
    expect(watched).toHaveBeenCalledTimes(1);
    expect(Signal.subtle.hasSinks(s)).toBe(true);
    expect(Signal.subtle.introspectSinks(s)).toEqual([]);
    dispose();
    expect(unwatched).toHaveBeenCalledTimes(1);
    expect(Signal.subtle.hasSinks(s)).toBe(false);
  });

  it('drops sources it stops reading', () => {
    const flag = new Signal.State(true);
    const a = new Signal.State('a');
    const b = new Signal.State('b');
    const fn = vi.fn(() => void (flag.get() ? a.get() : b.get()));
    effect(fn);
    flag.set(false);
    flush();
    a.set('x');
    flush();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(Signal.subtle.hasSinks(a)).toBe(false);
    b.set('y');
    flush();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('effects on the same source run in creation order', () => {
    const s = new Signal.State(0);
    const order: string[] = [];
    for (const name of ['a', 'b', 'c']) effect(() => void (s.get(), order.push(name)));
    order.length = 0;
    s.set(1);
    flush();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('a throw on the first run disposes the effect and rethrows', () => {
    const s = new Signal.State(1);
    const fn = vi.fn(() => {
      s.get();
      throw new Error('boom');
    });
    expect(() => effect(fn)).toThrowError('boom');
    expect(Signal.subtle.hasSinks(s)).toBe(false);
    s.set(2);
    flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throw on a re-run is reported by flush and the effect stays subscribed', () => {
    const s = new Signal.State(0);
    const fn = vi.fn(() => {
      if (s.get() === 1) throw new Error('boom');
    });
    effect(fn);
    s.set(1);
    expect(() => flush()).toThrowError('boom');
    s.set(2);
    flush();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('a throwing cleanup disposes the effect', () => {
    const s = new Signal.State(0);
    const fn = vi.fn(() => {
      s.get();
      return () => {
        throw new Error('cleanup');
      };
    });
    effect(fn);
    s.set(1);
    expect(() => flush()).toThrowError('cleanup');
    expect(Signal.subtle.hasSinks(s)).toBe(false);
    s.set(2);
    flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('one failing effect does not stop the others', () => {
    const s = new Signal.State(0);
    const ok = vi.fn(() => void s.get());
    effect(() => {
      if (s.get() === 1) throw new Error('first');
    });
    effect(ok);
    effect(() => {
      if (s.get() === 1) throw new Error('second');
    });
    s.set(1);
    expect(() => flush()).toThrowError('first');
    expect(ok).toHaveBeenCalledTimes(2);
  });

  it('an effect can dispose itself during its own run', () => {
    const s = new Signal.State(0);
    let dispose = () => {};
    const fn = vi.fn(() => {
      if (s.get() === 1) dispose();
    });
    dispose = effect(fn);
    s.set(1);
    flush();
    expect(Signal.subtle.hasSinks(s)).toBe(false);
    s.set(2);
    flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('disposing a queued effect stops it from running', () => {
    const s = new Signal.State(0);
    const fn = vi.fn(() => void s.get());
    const dispose = effect(fn);
    s.set(1);
    dispose();
    flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('effects that write each other throw a cycle error instead of hanging', () => {
    const a = new Signal.State(0);
    const b = new Signal.State(0);
    effect(() => b.set(a.get() + 1));
    effect(() => a.set(b.get() + 1));
    expect(() => flush()).toThrowError(/cycle/i);
    expect(() => flush()).not.toThrow();
  });

  it('flush called from inside an effect is a no-op', () => {
    const s = new Signal.State(0);
    const inner = vi.fn(() => void s.get());
    effect(inner);
    effect(() => {
      s.get();
      flush();
    });
    s.set(1);
    flush();
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
