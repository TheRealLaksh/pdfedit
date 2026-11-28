/**
 * The first visit: the engine is a large download, so say how far it is. The file is fetched here as well,
 * counting as it arrives; the engine worker is started afterwards and finds it in the browser's cache.
 */
import { create } from "zustand";
// the same hashed file the engine worker loads
import wasmUrl from "../../../node_modules/mupdf/dist/mupdf-wasm.wasm?url";
import { engineReady } from "../../engine/client";

/** size of the file once unpacked (the transfer is compressed, so its own length says nothing) */
export const ENGINE_BYTES = 10_416_688;

export const useBoot = create<{ ready: boolean; percent: number | null }>()(() => ({ ready: false, percent: null }));
void engineReady.then(() => useBoot.setState({ ready: true, percent: null }));

/** download the engine, reporting progress; resolves in every case so the worker can then start */
export async function prefetchEngine(): Promise<void> {
  // a saved copy answers at once: nothing to show
  if (navigator.serviceWorker?.controller) return;
  try {
    const response = await fetch(wasmUrl);
    if (!response.ok || !response.body) return;
    const reader = response.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (useBoot.getState().ready) continue;
      useBoot.setState({ percent: Math.min(99, Math.floor((received / ENGINE_BYTES) * 100)) });
    }
  } catch {
    /* offline or blocked: starting the worker reports it properly */
  }
}
