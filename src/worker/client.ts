import * as Comlink from 'comlink';
import type { EngineApi } from './engine.worker';

let api: Comlink.Remote<EngineApi> | null = null;

export function engine(): Comlink.Remote<EngineApi> {
  if (!api) {
    const w = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'cash-flow-engine' });
    api = Comlink.wrap<EngineApi>(w);
  }
  return api;
}

export const proxy = Comlink.proxy;
