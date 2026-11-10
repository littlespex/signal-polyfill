import {describe, expect, it, vi} from 'vitest';
import {Signal, effect} from '../../src/index.js';

describe('liveness after the last target leaves', () => {
  it('a Computed read by a disposed effect recomputes on get()', () => {
    const s = new Signal.State(1);
    const c = new Signal.Computed(() => s.get() * 10);
    const dispose = effect(() => void c.get());
    dispose();
    s.set(2);
    expect(c.get()).toBe(20);
  });

  it('a Computed unwatched by a Watcher recomputes on get()', () => {
    const s = new Signal.State(1);
    const c = new Signal.Computed(() => s.get() * 10);
    const w = new Signal.subtle.Watcher(() => {});
    w.watch(c);
    expect(c.get()).toBe(10);
    w.unwatch(c);
    s.set(2);
    expect(c.get()).toBe(20);
  });

  it('hooks on a State behind a Computed fire once each as an effect on the Computed is created and disposed', () => {
    const watched = vi.fn();
    const unwatched = vi.fn();
    const s = new Signal.State(1, {
      [Signal.subtle.watched]: watched,
      [Signal.subtle.unwatched]: unwatched,
    });
    const c = new Signal.Computed(() => s.get());
    const dispose = effect(() => void c.get());
    expect(watched).toHaveBeenCalledTimes(1);
    expect(unwatched).not.toHaveBeenCalled();
    dispose();
    expect(watched).toHaveBeenCalledTimes(1);
    expect(unwatched).toHaveBeenCalledTimes(1);
  });
});

describe('null hooks', () => {
  const hooks = {
    [Signal.subtle.watched]: null as never,
    [Signal.subtle.unwatched]: null as never,
  };

  it('are ignored on a State', () => {
    const s = new Signal.State(1, hooks);
    const w = new Signal.subtle.Watcher(() => {});
    expect(() => w.watch(s)).not.toThrow();
    expect(() => w.unwatch(s)).not.toThrow();
  });

  it('are ignored on a Computed', () => {
    const c = new Signal.Computed(() => 1, hooks);
    const w = new Signal.subtle.Watcher(() => {});
    expect(() => w.watch(c)).not.toThrow();
    expect(() => w.unwatch(c)).not.toThrow();
  });
});
