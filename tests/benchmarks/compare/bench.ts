import {testFramework} from 'js-reactivity-benchmark';
import type {ReactiveFramework} from 'js-reactivity-benchmark';
import {tc39SignalsProposalStage0} from '../adapter';
import {preactFramework} from './preact-adapter';

const frameworks: Record<string, ReactiveFramework> = {
  polyfill: tc39SignalsProposalStage0,
  preact: preactFramework,
};

const which = process.argv[2];
const framework = frameworks[which];
if (!framework) {
  console.error(`usage: node --expose-gc bench.js <${Object.keys(frameworks).join('|')}>`);
  process.exit(1);
}

const totals = {propagation: 0, create: 0, update: 0, dynamic: 0};

await testFramework({framework, testPullCounts: true}, (result) => {
  if (result.test.startsWith('create')) totals.create += result.time;
  else if (result.test.startsWith('update')) totals.update += result.time;
  else if (result.test.includes('sources')) totals.dynamic += result.time;
  else totals.propagation += result.time;
});

const ms = (n: number) => Math.round(n);
const total = totals.propagation + totals.create + totals.update + totals.dynamic;
console.log(
  `${which}  propagation ${ms(totals.propagation)}  create ${ms(totals.create)}` +
    `  update ${ms(totals.update)}  dynamic ${ms(totals.dynamic)}  total ${ms(total)}  (ms)`,
);
