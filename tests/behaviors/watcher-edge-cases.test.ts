import {describe, expect, it} from 'vitest';
import {Signal} from '../../src/index.js';

describe('Watcher edge cases', () => {
  it('a throwing notify callback does not leave live signals stale', () => {
    const s = new Signal.State(1);
    const double = new Signal.Computed(() => s.get() * 2);
    const bad1 = new Signal.subtle.Watcher(() => {
      throw new Error('notify');
    });
    const bad2 = new Signal.subtle.Watcher(() => {
      throw new Error('notify');
    });
    const good = new Signal.subtle.Watcher(() => {});
    bad1.watch(s);
    good.watch(double);
    expect(double.get()).toBe(2);
    bad2.watch(s);

    expect(() => s.set(2)).toThrowError('notify');
    expect(good.getPending()).toEqual([double]);
    expect(double.get()).toBe(4);
    expect(() => s.set(3)).not.toThrow();
    expect(double.get()).toBe(6);
  });

  it('a clean computed is not pending right after watch', () => {
    const s = new Signal.State(1);
    const c = new Signal.Computed(() => s.get());
    c.get();
    const w = new Signal.subtle.Watcher(() => {});
    w.watch(c);
    expect(w.getPending()).toEqual([]);
  });

  it('a watched computed recomputes after a nested computed wrote one of its sources', () => {
    const v = new Signal.State(0);
    const c1 = new Signal.Computed(() => {
      if (v.get() === 0) v.set(1);
      return 'foo';
    });
    const c2 = new Signal.Computed(() => v.get() + c1.get());
    const w = new Signal.subtle.Watcher(() => {});
    w.watch(c2);
    expect(c2.get()).toBe('0foo');
    expect(c2.get()).toBe('1foo');
  });
});
