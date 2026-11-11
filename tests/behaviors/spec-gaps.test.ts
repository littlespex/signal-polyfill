import {describe, expect, it} from 'vitest';
import {Signal} from '../../src/wrapper.js';

/**
 * Cases where the proposal text is silent, ambiguous, or cannot be followed
 * literally. Each test pins the choice this polyfill makes.
 */
describe('Spec gaps', () => {
  describe('staleness', () => {
    it('recomputes a watched computed whose direct source changes after an indirect one', () => {
      const s1 = new Signal.State(1);
      const s2 = new Signal.State(10);
      const a = new Signal.Computed(() => s1.get());
      const c = new Signal.Computed(() => a.get() + s2.get());
      const w = new Signal.subtle.Watcher(() => {});
      w.watch(c);
      expect(c.get()).toBe(11);

      s1.set(2); // c is reached through a
      s2.set(20); // c is reached directly, while already marked
      expect(c.get()).toBe(22);
    });

    function writeDuringValidation(live: boolean) {
      const trigger = new Signal.State(0);
      const other = new Signal.State(0);
      const b = new Signal.Computed(() => other.get());
      // a's value never changes, but running it writes to a source of b.
      const a = new Signal.Computed(() => {
        other.set(trigger.get());
        return 0;
      });
      const c = new Signal.Computed(() => b.get() + a.get());
      let notified = 0;
      const w = new Signal.subtle.Watcher(() => notified++);
      if (live) w.watch(c);

      expect(c.get()).toBe(0);
      trigger.set(5);
      if (live) expect(notified).toBe(1);
      // b is validated before a runs and writes to b's source.
      expect(c.get()).toBe(5);
      expect(b.get()).toBe(5);
    }

    it('revalidates when a source writes a State during validation (not watched)', () =>
      writeDuringValidation(false));
    it('revalidates when a source writes a State during validation (watched)', () =>
      writeDuringValidation(true));

    it('walks a graph with many converging paths once per set', () => {
      const s = new Signal.State(0);
      let left: Signal.Computed<number> = new Signal.Computed(() => s.get());
      let right: Signal.Computed<number> = new Signal.Computed(() => s.get());
      for (let i = 0; i < 40; i++) {
        const l = left;
        const r = right;
        left = new Signal.Computed(() => l.get() + r.get());
        right = new Signal.Computed(() => l.get() - r.get());
      }
      let notified = 0;
      const w = new Signal.subtle.Watcher(() => notified++);
      w.watch(left, right);
      left.get();
      right.get();

      // 2^40 paths lead from s to the watcher. This must not visit each one.
      s.set(1);
      expect(notified).toBe(1);
      expect(w.getPending()).toStrictEqual([left, right]);
    });
  });

  describe('Watcher', () => {
    it('rethrows a single notify error from set, after the value is stored', () => {
      const s = new Signal.State(1);
      const error = new Error('notify');
      const w = new Signal.subtle.Watcher(() => {
        throw error;
      });
      w.watch(s);

      let thrown: unknown;
      try {
        s.set(2);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBe(error);
      expect(s.get()).toBe(2);
    });

    it('runs every notify and throws an AggregateError when several throw', () => {
      const s = new Signal.State(1);
      const e1 = new Error('one');
      const e2 = new Error('two');
      let third = 0;
      const w1 = new Signal.subtle.Watcher(() => {
        throw e1;
      });
      const w2 = new Signal.subtle.Watcher(() => {
        throw e2;
      });
      const w3 = new Signal.subtle.Watcher(() => third++);
      w1.watch(s);
      w2.watch(s);
      w3.watch(s);

      let thrown: unknown;
      try {
        s.set(2);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toStrictEqual([e1, e2]);
      expect(third).toBe(1);
    });

    it('notifies once until re-armed, and still marks computeds stale', () => {
      const s = new Signal.State(1);
      const c = new Signal.Computed(() => s.get());
      let notified = 0;
      const w = new Signal.subtle.Watcher(() => notified++);
      w.watch(c);
      c.get();

      s.set(2);
      s.set(3);
      expect(notified).toBe(1);
      expect(w.getPending()).toStrictEqual([c]);

      // Re-armed while c is still stale: the next set must notify again.
      w.watch();
      s.set(4);
      expect(notified).toBe(2);
      expect(c.get()).toBe(4);
    });

    it('lists pending computeds in watch order and never lists States', () => {
      const s = new Signal.State(1);
      const a = new Signal.Computed(() => s.get() + 1);
      const b = new Signal.Computed(() => s.get() + 2);
      const c = new Signal.Computed(() => s.get() + 3);
      const w = new Signal.subtle.Watcher(() => {});
      w.watch(c, s, a, b);
      c.get();
      a.get();
      b.get();
      expect(w.getPending()).toStrictEqual([]);

      s.set(2);
      expect(w.getPending()).toStrictEqual([c, a, b]);
      a.get();
      expect(w.getPending()).toStrictEqual([c, b]);
    });

    it('does not watch the same signal twice', () => {
      const s = new Signal.State(1);
      const w = new Signal.subtle.Watcher(() => {});
      w.watch(s, s);
      w.watch(s);
      expect(Signal.subtle.introspectSources(w)).toStrictEqual([s]);
      expect(Signal.subtle.introspectSinks(s)).toStrictEqual([w]);
      w.unwatch(s);
      expect(Signal.subtle.hasSinks(s)).toBe(false);
    });

    it('throws when unwatching a signal it is not watching', () => {
      const s = new Signal.State(1);
      const other = new Signal.State(2);
      const w = new Signal.subtle.Watcher(() => {});
      w.watch(s);
      expect(() => w.unwatch(other)).toThrow();
      // Nothing was removed by the failed call.
      expect(() => w.unwatch(s, other)).toThrow();
      expect(Signal.subtle.introspectSources(w)).toStrictEqual([s]);
    });

    it('disallows watch and unwatch during notify', () => {
      const s = new Signal.State(1);
      const other = new Signal.State(2);
      const errors: unknown[] = [];
      const w: Signal.subtle.Watcher = new Signal.subtle.Watcher(() => {
        try {
          w.watch(other);
        } catch (e) {
          errors.push(e);
        }
        try {
          w.unwatch(s);
        } catch (e) {
          errors.push(e);
        }
      });
      w.watch(s);
      s.set(2);
      expect(errors).toHaveLength(2);
      expect(Signal.subtle.introspectSources(w)).toStrictEqual([s]);
    });
  });

  describe('watched and unwatched callbacks', () => {
    it('disallows reads and writes inside the callbacks', () => {
      const other = new Signal.State(0);
      const s = new Signal.State(1, {
        [Signal.subtle.watched]() {
          other.get();
        },
        [Signal.subtle.unwatched]() {
          other.set(1);
        },
      });
      const w = new Signal.subtle.Watcher(() => {});
      expect(() => w.watch(s)).toThrow();
      // The graph work still completed.
      expect(Signal.subtle.introspectSources(w)).toStrictEqual([s]);
      expect(() => w.unwatch(s)).toThrow();
      expect(Signal.subtle.introspectSources(w)).toStrictEqual([]);
      expect(other.get()).toBe(0);
    });

    it('calls sources before the signals that read them', () => {
      const order: string[] = [];
      const hooks = (name: string) => ({
        [Signal.subtle.watched]: () => void order.push(`+${name}`),
        [Signal.subtle.unwatched]: () => void order.push(`-${name}`),
      });
      const s1 = new Signal.State(1, hooks('s1'));
      const s2 = new Signal.State(2, hooks('s2'));
      const inner = new Signal.Computed(() => s1.get(), hooks('inner'));
      const outer = new Signal.Computed(() => inner.get() + s2.get(), hooks('outer'));
      outer.get();
      expect(order).toStrictEqual([]);

      const w = new Signal.subtle.Watcher(() => {});
      w.watch(outer);
      expect(order).toStrictEqual(['+s1', '+inner', '+s2', '+outer']);

      order.length = 0;
      w.unwatch(outer);
      expect(order).toStrictEqual(['-s1', '-inner', '-s2', '-outer']);
    });

    it('does not fire for a source that stays read across a recompute', () => {
      let watched = 0;
      let unwatched = 0;
      const s = new Signal.State(1, {
        [Signal.subtle.watched]: () => void watched++,
        [Signal.subtle.unwatched]: () => void unwatched++,
      });
      const c = new Signal.Computed(() => s.get());
      const w = new Signal.subtle.Watcher(() => {});
      w.watch(c);
      c.get();
      s.set(2);
      c.get();
      s.set(3);
      c.get();
      expect(watched).toBe(1);
      expect(unwatched).toBe(0);
    });
  });

  describe('unwatched computeds', () => {
    it('are not referenced by their sources', () => {
      const s = new Signal.State(1);
      const inner = new Signal.Computed(() => s.get());
      const outer = new Signal.Computed(() => inner.get());
      expect(outer.get()).toBe(1);
      expect(Signal.subtle.hasSinks(s)).toBe(false);
      expect(Signal.subtle.hasSinks(inner)).toBe(false);
      expect(Signal.subtle.introspectSources(outer)).toStrictEqual([inner]);
    });

    it('record each source once, in the order of the latest run', () => {
      const a = new Signal.State(1);
      const b = new Signal.State(2);
      const flip = new Signal.State(false);
      const inner = new Signal.Computed(() => a.get());
      const c = new Signal.Computed(() => {
        const first = flip.get() ? b : a;
        const second = flip.get() ? a : b;
        // inner reads a too: a nested run must not disturb this run's record.
        return first.get() + inner.get() + second.get() + first.get();
      });
      c.get();
      expect(Signal.subtle.introspectSources(c)).toStrictEqual([flip, a, inner, b]);
      flip.set(true);
      c.get();
      expect(Signal.subtle.introspectSources(c)).toStrictEqual([flip, b, inner, a]);
    });
  });

  describe('errors and writes inside callbacks', () => {
    it('keeps a computed clean when it writes a State and reads it back', () => {
      const s = new Signal.State(1);
      const unrelated = new Signal.State(0);
      let runs = 0;
      const c = new Signal.Computed(() => {
        runs++;
        s.set(s.get() + 1);
        return s.get();
      });
      expect(c.get()).toBe(2);

      // The last thing c saw of s is its current value, so c is up to date.
      unrelated.set(1);
      expect(c.get()).toBe(2);
      expect(runs).toBe(1);
    });

    it('throws from set when a State equals throws, and keeps the old value', () => {
      const s = new Signal.State(1, {
        equals() {
          throw new Error('equals');
        },
      });
      expect(() => s.set(2)).toThrowError('equals');
      expect(s.get()).toBe(1);
    });

    it('caches a watched callback error raised by a run as the computed value', () => {
      const s = new Signal.State(1, {
        [Signal.subtle.watched]() {
          throw new Error('watched');
        },
      });
      let runs = 0;
      const c = new Signal.Computed(() => (runs++, s.get()));
      const w = new Signal.subtle.Watcher(() => {});
      w.watch(c); // c has no sources yet, so nothing becomes watched here.

      expect(() => c.get()).toThrowError('watched');
      expect(() => c.get()).toThrowError('watched');
      expect(runs).toBe(1);
      expect(Signal.subtle.introspectSinks(s)).toStrictEqual([c]);
    });
  });

  describe('cycles that appear on a rerun', () => {
    function build() {
      const s = new Signal.State(false);
      const unrelated = new Signal.State(0);
      const a: Signal.Computed<number> = new Signal.Computed(() => b.get() + 1);
      const b: Signal.Computed<number> = new Signal.Computed(() => (s.get() ? a.get() : 0));
      return {s, unrelated, a, b};
    }

    it('keep throwing the cycle error, and heal when the cycle is gone', () => {
      const {s, unrelated, a, b} = build();
      expect(a.get()).toBe(1);

      s.set(true);
      expect(() => a.get()).toThrowError(/cycle/i);
      unrelated.set(1);
      expect(() => a.get()).toThrowError(/cycle/i);
      expect(() => b.get()).toThrowError(/cycle/i);
      // b never got a link back to a: the two do not hold each other.
      expect(Signal.subtle.introspectSources(b)).toStrictEqual([s]);

      s.set(false);
      expect(a.get()).toBe(1);
      expect(b.get()).toBe(0);
    });

    it('leave nothing live once the Watcher is gone', () => {
      const {s, a, b} = build();
      const w = new Signal.subtle.Watcher(() => {});
      w.watch(a);
      expect(a.get()).toBe(1);
      s.set(true);
      expect(() => a.get()).toThrowError(/cycle/i);

      w.unwatch(a);
      expect(Signal.subtle.hasSinks(a)).toBe(false);
      expect(Signal.subtle.hasSinks(b)).toBe(false);
      expect(Signal.subtle.hasSinks(s)).toBe(false);
    });
  });

  describe('writes inside computed callbacks', () => {
    function writeAfterRead(live: boolean) {
      const loading = new Signal.State(false);
      const unrelated = new Signal.State(0);
      let started = false;
      const status = new Signal.Computed(() => {
        const was = loading.get();
        if (!started) {
          started = true;
          loading.set(true);
        }
        return was ? 'loading' : 'idle';
      });
      const w = new Signal.subtle.Watcher(() => {});
      if (live) w.watch(status);

      // The run that wrote `loading` had already read the old value. It keeps
      // that value until something is set (the Vue-derived tests pin this).
      expect(status.get()).toBe('idle');
      expect(status.get()).toBe('idle');
      if (live) expect(w.getPending()).toStrictEqual([]);

      // After any set a read checks it again, watched or not.
      unrelated.set(1);
      expect(status.get()).toBe('loading');
      if (live) expect(w.getPending()).toStrictEqual([]);
    }

    it('catch up after the next set when a computed wrote a State it had read (not watched)', () =>
      writeAfterRead(false));
    it('catch up after the next set when a computed wrote a State it had read (watched)', () =>
      writeAfterRead(true));

    function writeByLaterSource(live: boolean) {
      const a = new Signal.State(0);
      const trigger = new Signal.State(0);
      const other = new Signal.State(0);
      const unrelated = new Signal.State(0);
      const e = new Signal.Computed(() => a.get());
      const b = new Signal.Computed(() => other.get());
      const writer = new Signal.Computed(() => {
        other.set(trigger.get());
        return 0;
      });
      const c = new Signal.Computed(() => e.get() + b.get() + writer.get());
      const w = new Signal.subtle.Watcher(() => {});
      if (live) w.watch(c);
      expect(c.get()).toBe(0);

      a.set(1);
      trigger.set(5);
      // e changed, so c reruns at once. It reads b before writer sets b's source.
      expect(c.get()).toBe(1);
      expect(b.get()).toBe(5);

      unrelated.set(1);
      expect(c.get()).toBe(6);
    }

    it('catch up after the next set when a later source wrote a State (not watched)', () =>
      writeByLaterSource(false));
    it('catch up after the next set when a later source wrote a State (watched)', () =>
      writeByLaterSource(true));
  });

  describe('readers of a computed that wrote a State', () => {
    it('are checked again together with it (watched reader)', () => {
      const a = new Signal.State(0);
      const unrelated = new Signal.State(0);
      // Reads a, then writes it once: its first value predates its own write.
      const writer = new Signal.Computed(() => {
        const value = a.get();
        if (value === 0) a.set(1);
        return value;
      });
      const reader = new Signal.Computed(() => writer.get() * 10);
      const w = new Signal.subtle.Watcher(() => {});
      w.watch(reader);

      expect(writer.get()).toBe(0);
      expect(reader.get()).toBe(0);

      unrelated.set(1);
      expect(reader.get()).toBe(10);
      expect(writer.get()).toBe(1);
    });

    function consistentAfterTwoWriters(live: boolean) {
      const a = new Signal.State(0);
      const log = new Signal.State(0);
      const first = new Signal.Computed(() => {
        const old = a.get();
        a.set(1);
        return old;
      });
      const second = new Signal.Computed(() => {
        log.set(1);
        return 0;
      });
      const sum = new Signal.Computed(() => first.get() + second.get());
      const w = new Signal.subtle.Watcher(() => {});
      if (live) w.watch(sum);
      expect(sum.get()).toBe(0);

      // `second` wrote after `first` ran, so `first` is due for a check. When
      // that check changes its value, `sum` must follow.
      const parts = first.get() + second.get();
      expect(sum.get()).toBe(parts);
    }

    it('never hold a value their sources no longer return (not watched)', () =>
      consistentAfterTwoWriters(false));
    it('never hold a value their sources no longer return (watched)', () =>
      consistentAfterTwoWriters(true));

    it('become pending again on a later set, without the Watcher being re-armed', () => {
      const s = new Signal.State(0);
      const inner = new Signal.Computed(() => s.get());
      const outer = new Signal.Computed(() => {
        const value = inner.get();
        if (value === 1) s.set(2);
        return value;
      });
      const w = new Signal.subtle.Watcher(() => {});
      w.watch(outer);
      expect(outer.get()).toBe(0);

      s.set(1);
      expect(outer.get()).toBe(1); // this run set s to 2
      s.set(3);
      expect(w.getPending()).toStrictEqual([outer]);
      expect(outer.get()).toBe(3);
    });
  });

  describe('repeated sets and deep graphs', () => {
    it('notify a Watcher that starts watching below computeds that are already stale', () => {
      const s = new Signal.State(0);
      const c = new Signal.Computed(() => s.get());
      const d = new Signal.Computed(() => c.get());
      let first = 0;
      let second = 0;
      const w1 = new Signal.subtle.Watcher(() => first++);
      w1.watch(c);
      c.get();
      d.get();

      s.set(1);
      s.set(2);
      expect(first).toBe(1);

      const w2 = new Signal.subtle.Watcher(() => second++);
      w2.watch(d);
      s.set(3);
      expect(second).toBe(1);
      expect(first).toBe(1);
      expect(d.get()).toBe(3);
    });

    it('watch, mark and unwatch a chain of 20000 computeds', () => {
      const s = new Signal.State(0);
      const chain: Signal.Computed<number>[] = [];
      let prev: {get(): number} = s;
      for (let i = 0; i < 20000; i++) {
        const source = prev;
        const c = new Signal.Computed(() => source.get() + 1);
        c.get();
        chain.push(c);
        prev = c;
      }
      const tail = chain[chain.length - 1];
      let notified = 0;
      const w = new Signal.subtle.Watcher(() => notified++);

      w.watch(tail);
      expect(Signal.subtle.hasSinks(s)).toBe(true);
      s.set(1);
      expect(notified).toBe(1);
      for (const c of chain) c.get();
      expect(tail.get()).toBe(20001);

      w.unwatch(tail);
      expect(Signal.subtle.hasSinks(s)).toBe(false);
      expect(Signal.subtle.hasSinks(chain[0])).toBe(false);
    });
  });

  describe('options and hook errors', () => {
    it('ignore null and undefined options', () => {
      const options = {
        equals: null,
        [Signal.subtle.watched]: null,
        [Signal.subtle.unwatched]: undefined,
      } as unknown as Signal.Options<number>;
      const s = new Signal.State(1, options);
      const c = new Signal.Computed(() => s.get(), options);
      const w = new Signal.subtle.Watcher(() => {});
      w.watch(c);
      expect(c.get()).toBe(1);
      s.set(2);
      expect(c.get()).toBe(2);
      w.unwatch(c);
    });

    it('throw a hook error from the call that caused it, not from a nested watch', () => {
      const s = new Signal.State(1, {
        [Signal.subtle.watched]() {
          throw new Error('watched');
        },
      });
      const quiet = new Signal.State(0);
      const inner = new Signal.subtle.Watcher(() => {});
      let stolen: unknown;
      const c = new Signal.Computed(() => {
        const value = s.get(); // makes s watched: its hook throws
        try {
          inner.watch(quiet); // unrelated, and must not report that error
        } catch (error) {
          stolen = error;
        }
        return value;
      });
      const w = new Signal.subtle.Watcher(() => {});
      w.watch(c);

      expect(() => c.get()).toThrowError('watched');
      expect(stolen).toBe(undefined);
      expect(Signal.subtle.introspectSources(inner)).toStrictEqual([quiet]);
    });
  });

  describe('guards', () => {
    it('do not throw on null', () => {
      expect(Signal.isState(null)).toBe(false);
      expect(Signal.isComputed(null)).toBe(false);
      expect(Signal.isWatcher(null)).toBe(false);
    });
  });
});
