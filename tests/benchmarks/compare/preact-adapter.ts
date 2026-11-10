import {batch, computed, effect, signal} from '@preact/signals-core';
import type {ReactiveFramework} from 'js-reactivity-benchmark';

export const preactFramework: ReactiveFramework = {
  name: '@preact/signals-core',
  signal: (v) => {
    const s = signal(v);
    return {read: () => s.value, write: (x) => void (s.value = x)};
  },
  computed: (fn) => {
    const c = computed(fn);
    return {read: () => c.value};
  },
  effect: (fn) => void effect(() => void fn()),
  withBatch: (fn) => void batch(fn),
  withBuild: (fn) => fn(),
};
