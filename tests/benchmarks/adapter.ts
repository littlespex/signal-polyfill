import {ReactiveFramework} from 'js-reactivity-benchmark';
import {Signal, batch, effect, setScheduler} from '../../src/index.js';

// The benchmark reads pull counts after every write, so effects run synchronously.
setScheduler((f) => f());

export const tc39SignalsProposalStage0: ReactiveFramework = {
  name: 'TC39 Signals Polyfill',
  signal: (initialValue) => {
    const s = new Signal.State(initialValue);
    return {
      write: (v) => s.set(v),
      read: () => s.get(),
    };
  },
  computed: (fn) => {
    const c = new Signal.Computed(fn);
    return {
      read: () => c.get(),
    };
  },
  effect: (fn) => void effect(() => void fn()),
  withBatch: (fn) => void batch(fn),
  withBuild: (fn) => fn(),
};
