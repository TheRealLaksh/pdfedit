/** Main-thread proxy for the engine worker: `await engine.renderPage(0, 2)` */
import type { EngineAPI, EngineRequest, EngineResponse } from "./types";

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function start(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<EngineResponse>) => {
    const msg = event.data;
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    if (msg.ok) call.resolve(msg.result);
    else call.reject(Object.assign(new Error(msg.error), { stack: msg.stack }));
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || "The PDF engine stopped unexpectedly");
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export const engine = new Proxy({} as EngineAPI, {
  get(_target, method: string) {
    return (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        start().postMessage({ id, method, args } as EngineRequest);
      });
  },
});

/** load the worker and wasm before the user picks a file */
export function warmUpEngine(): void {
  start();
}
