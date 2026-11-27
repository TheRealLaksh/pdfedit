/** Main-thread proxy for the engine worker: `await engine.renderPage(0, 2)` */
import type { EngineAPI, EngineRequest, EngineResponse } from "./types";

let worker: Worker | null = null;
/** the worker only listens once its wasm modules have loaded: hold calls until it says so */
let ready = false;
let backlog: EngineRequest[] = [];
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function start(): Worker {
  if (worker) return worker;
  ready = false;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<EngineResponse>) => {
    const msg = event.data;
    if (msg.id === 0) {
      ready = true;
      for (const request of backlog) worker?.postMessage(request);
      backlog = [];
      return;
    }
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
    backlog = [];
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
        const request = { id, method, args } as EngineRequest;
        const target = start();
        if (ready) target.postMessage(request);
        else backlog.push(request);
      });
  },
});

/** load the worker and wasm before the user picks a file */
export function warmUpEngine(): void {
  start();
}
