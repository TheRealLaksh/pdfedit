/** Runs the image session off the main thread. */
import { createAssetLoader } from "../engine/context";
import { ImageSession } from "./session";
import type { Picture } from "./types";

export type WorkerRequest = { id: number; method: "open" | "analyze" | "render" | "sample" | "crop" | "addFont"; args: unknown[] };
export type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
/** sent once the worker listens: anything posted while its modules (and wasm) load would be lost */
export const READY = -1;

let session: ImageSession | null = null;
const assets = createAssetLoader();
/** one job at a time, in order: renders must not overtake each other */
let queue: Promise<unknown> = Promise.resolve();

async function run({ method, args }: WorkerRequest): Promise<unknown> {
  if (method === "open") {
    session = new ImageSession(args[0] as Picture, assets);
    return null;
  }
  if (!session) throw new Error("No picture is open.");
  const call = session[method] as (...a: unknown[]) => unknown;
  return call.apply(session, args);
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    let reply: WorkerReply;
    try {
      reply = { id: request.id, ok: true, result: await run(request) };
    } catch (e) {
      reply = { id: request.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    self.postMessage(reply);
  });
};
self.postMessage({ id: READY, ok: true, result: null } satisfies WorkerReply);
