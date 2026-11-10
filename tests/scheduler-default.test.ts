import {expect, it, vi} from 'vitest';
import {Signal, effect} from '../src/index.js';

it('default scheduler runs effects once, after a microtask', async () => {
  const s = new Signal.State(0);
  const fn = vi.fn(() => void s.get());
  effect(fn);
  s.set(1);
  s.set(2);
  expect(fn).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(fn).toHaveBeenCalledTimes(2);
});
