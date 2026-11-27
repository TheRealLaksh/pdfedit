/// <reference lib="webworker" />
import { Engine } from "./engine";
import type { EngineRequest, EngineResponse } from "./types";

const engine = new Engine();
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (event: MessageEvent<EngineRequest>) => {
  const { id, method, args } = event.data;
  // one call at a time: modules share one mutable document
  queue = queue.then(async () => {
    try {
      const fn = engine[method] as (...a: unknown[]) => Promise<unknown>;
      const result = await fn.apply(engine, args);
      const reply: EngineResponse = { id, ok: true, result };
      self.postMessage(reply, transferables(result));
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error(`engine.${method}`, error);
      const reply: EngineResponse = { id, ok: false, error: error.message, stack: error.stack };
      self.postMessage(reply);
    }
  });
};

/** transfer big buffers that the engine does not keep */
function transferables(result: unknown): Transferable[] {
  if (result instanceof Uint8Array) return isOwned(result) ? [result.buffer as ArrayBuffer] : [];
  if (result && typeof result === "object" && "data" in result) {
    const data = (result as { data: unknown }).data;
    if (data instanceof Uint8ClampedArray) return [data.buffer as ArrayBuffer];
  }
  return [];
}

/** never transfer a view into the wasm heap */
function isOwned(a: Uint8Array): boolean {
  return a.byteOffset === 0 && a.byteLength === a.buffer.byteLength && a.byteLength < 1 << 29;
}

self.postMessage({ id: 0, ok: true, result: "ready" } satisfies EngineResponse);
