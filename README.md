# Signal Polyfill

## ⚠️ This polyfill is a preview of an in-progress proposal and could change at any time. Do not use this in production. ⚠️

A "signal" is [a proposed first-class JavaScript data type](https://github.com/tc39/proposal-signals) that enables one-way data flow through cells of state or computations derived from other state/computations.

This is a polyfill for the `Signal` API.

## Examples

### Using signals

- Use `Signal.State(value)` to create a single "cell" of data that can flow through the unidirectional state graph.
- Use `Signal.Computed(callback)` to define a computation based on state or other computations flowing through the graph.

```js
import { Signal, effect } from "signal-polyfill";

const counter = new Signal.State(0);
const isEven = new Signal.Computed(() => (counter.get() & 1) == 0);
const parity = new Signal.Computed(() => (isEven.get() ? "even" : "odd"));

effect(() => console.log(parity.get())); // Console logs "even" immediately.
setInterval(() => counter.set(counter.get() + 1), 1000); // Changes the counter every 1000ms.

// effect triggers console log "odd"
// effect triggers console log "even"
// effect triggers console log "odd"
// ...
```

The signal proposal does not include an `effect` API, since such APIs are often deeply integrated with rendering and batch strategies that are highly framework/library dependent. However, the proposal does seek to define a set of primitives that library authors can use to implement their own effects. This fork adds its own `effect`, described under [Effects and scheduling](#effects-and-scheduling).

When working directly with library effect APIs, always be sure to understand the behavior of the `effect` implementation. While the signal algorithm is standardized, effects are not and may vary. To illustrate this, have a look at this code:

```js
counter.get(); // 0
effect(() => counter.set(counter.get() + 1)); // Infinite loop???
counter.get(); // 1
```

Depending on how the effect is implemented, the above code could result in an infinite loop. It's also important to note that running the effect, in this case, causes an immediate invocation of the callback, changing the value of the counter.

### Effects and scheduling

The signal proposal does not include `effect`, `batch`, `flush` or `setScheduler`. These four are additions in this fork and are not part of the TC39 proposal. They are exported beside `Signal`, not inside it.

```ts
type Scheduler = (flush: () => void) => void;

effect(fn: () => void | (() => void)): () => void;
batch<T>(fn: () => T): T;
flush(): void;
setScheduler(scheduler: Scheduler | null): void;
```

- `effect(fn)` runs `fn` once, immediately, and runs it again whenever a signal it read changes. It returns a function that disposes the effect. If `fn` returns a function, that function is the effect's cleanup. It runs before the next run and when the effect is disposed.
- `batch(fn)` runs `fn` and returns its result. Writes made inside `fn` queue effects, and the scheduler is asked once, when the outermost `batch` ends, not after each write.
- `flush()` runs the pending effects now.
- `setScheduler(scheduler)` decides when pending effects run. When an effect becomes pending, the scheduler is called with a `flush` function, and it decides when to call it. Passing `null` removes the scheduler, so nothing runs until the app calls `flush()`.

There are three modes:

| mode                | install                                   | effects run                                                 |
| ------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| microtask (default) | nothing                                   | once, after the current task                                |
| synchronous         | `setScheduler((flush) => flush())`        | at the end of the outermost write, computation or `batch`   |
| manual              | `setScheduler(null)`, then call `flush()` | when the app calls `flush()`, for example from `timeupdate` |

```js
import { Signal, effect, setScheduler, flush } from "signal-polyfill";

// Writes queue effects. Nothing runs until the app calls flush().
setScheduler(null);

const video = document.querySelector("video");
const time = new Signal.State(0);

effect(() => console.log(time.get())); // Logs 0 immediately.

video.addEventListener("timeupdate", () => {
  time.set(video.currentTime); // Queues the effect.
  flush(); // Runs it, so the effect logs the new time.
});
```

A few behaviors are worth knowing before you rely on them.

- Order: when a signal is written, the effects that read that signal directly run in the order they subscribed. Order is otherwise unspecified: across effects that reach the signal through different computeds, and across several writes before one flush.
- Nested flushes: `flush()` does nothing when a flush is already running, for example when an effect that is re-running during a flush calls it, and it does nothing inside a `Signal.subtle.Watcher` notify callback, where signals cannot be read. In both cases the pending effects run at the next flush. An effect's first run happens inside `effect()`, not inside a flush, so a `flush()` there runs the pending effects.
- Errors: every pending effect runs even if one throws, and `flush()` then rethrows the first error. Under the default scheduler that error is an uncaught exception in the microtask. An effect that throws on its first run is disposed, and the error is thrown from `effect()`. Effects that keep triggering themselves or each other stop after 100 passes with an error whose message contains "cycle". That includes the self-triggering example above.
- Synchronous scheduler: the flush runs inside whichever call finished the outermost write, computation or batch, so an effect's error surfaces from that call.

To build effects with different semantics, `Signal.subtle.Watcher` and `Signal.Computed` are the primitives the proposal provides. Use `Signal.subtle.Watcher#getPending()` to retrieve the dirty signals and `Signal.subtle.Watcher#watch()` with no arguments to re-arm the notify callback.

> [!IMPORTANT]
> The `Signal.subtle` APIs are so named in order to communicate that their correct use requires careful attention to detail. These APIs are not targeted at application-level code, but rather at framework/library authors.

### Combining signals and decorators

A class accessor decorator can be combined with the `Signal.State()` API to enable improved DX.

```js
import { Signal } from "signal-polyfill";

export function signal(target) {
  const { get } = target;

  return {
    get() {
      return get.call(this).get();
    },

    set(value) {
      get.call(this).set(value);
    },

    init(value) {
      return new Signal.State(value);
    },
  };
}
```

The above decorator can be used on public or **private** accessors, enabling reactivity while carefully controlling state mutations.

```js
export class Counter {
  @signal accessor #value = 0;

  get value() {
    return this.#value;
  }

  increment() {
    this.#value++;
  }

  decrement() {
    if (this.#value > 0) {
      this.#value--;
    }
  }
}
```

## Contributing

- clone the repo, `git clone git@github.com:proposal-signals/signal-polyfill.git`
- `cd signal-polyfill`
- use your favorite package manager to install dependencies, e.g.: `pnpm install`, `npm install`, `yarn install`, etc
- make your change
- add and run tests
- open a PR
- collaborate 🥳
