/// <reference lib="webworker" />
import { answer, Engine } from "./engine";
import type { EngineRequest, EngineResponse } from "./types";

const engine = new Engine();
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (event: MessageEvent<EngineRequest>) => {
  // one call at a time: modules share one mutable document
  queue = queue.then(async () => {
    const reply = await answer(engine, event.data);
    if (!reply.ok) console.error(`engine.${event.data.method}`, reply.stack ?? reply.error);
    self.postMessage(reply, reply.ok ? transferables(reply.result) : []);
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
