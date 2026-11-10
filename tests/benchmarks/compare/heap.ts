import type {Computed, ReactiveFramework, Signal} from 'js-reactivity-benchmark';
import {tc39SignalsProposalStage0} from '../adapter';
import {preactFramework} from './preact-adapter';

const N = 100_000;

const frameworks: Record<string, ReactiveFramework> = {
  polyfill: tc39SignalsProposalStage0,
  preact: preactFramework,
};

const which = process.argv[2];
const framework = frameworks[which];
if (!framework) {
  console.error(`usage: node --expose-gc heap.js <${Object.keys(frameworks).join('|')}>`);
  process.exit(1);
}
if (!globalThis.gc) {
  console.error('run with node --expose-gc');
  process.exit(1);
}

function heapUsed(): number {
  globalThis.gc!();
  globalThis.gc!();
  return process.memoryUsage().heapUsed;
}

// Every created object stays reachable until the end of the script.
const signals: Signal<number>[] = [];
const computeds: Computed<number>[] = [];

const base = heapUsed();

for (let i = 0; i < N; i++) signals.push(framework.signal(i));
const afterState = heapUsed();

for (let i = 0; i < N; i++) {
  const s = signals[i];
  const c = framework.computed(() => s.read());
  c.read();
  computeds.push(c);
}
const afterComputed = heapUsed();

for (let i = 0; i < N; i++) {
  const c = computeds[i];
  framework.effect(() => void c.read());
}
const afterEffect = heapUsed();

const perNode = (bytes: number) => Math.round(bytes / N);
console.log(
  `${which}  state ${perNode(afterState - base)}  computed ${perNode(afterComputed - afterState)}` +
    `  effect ${perNode(afterEffect - afterComputed)}  total ${perNode(afterEffect - base)}` +
    `  (bytes per node, N=${N})`,
);

// Referenced after the last measurement so the arrays cannot be collected early.
if (signals.length !== N || computeds.length !== N) throw new Error('unreachable');
