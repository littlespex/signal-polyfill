import {
  State,
  Computed,
  isState,
  isComputed,
  untrack,
  currentComputed,
  introspectSources,
  hasSources,
} from './core.js';

export const Signal = {
  State,
  Computed,
  isState,
  isComputed,
  subtle: {untrack, currentComputed, introspectSources, hasSources},
};
