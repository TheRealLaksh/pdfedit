/** Main thread side of the image worker. A worker that dies is replaced and given the picture again. */
import type { WorkerReply, WorkerRequest } from "./image.worker";
import type { FaceRef } from "./fonts/shape";
import type { Analysis, BoxEdit, Picture, Quad4, RenderResult, TextBox, Align } from "./types";

export interface FontSample {
  width: number;
  height: number;
  alpha: Uint8Array<ArrayBuffer>;
}

export interface UploadedFont {
  key: string;
  family: string;
  weight: number;
  italic: boolean;
}

export class ImageClient {
  private worker: Worker | null = null;
  /** requests held until the worker listens */
  private held: WorkerRequest[] | null = [];
  private waiting = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  private next = 1;
  private fonts: [string, Uint8Array][] = [];
  private closed = false;

  constructor(private picture: Picture) {}

  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./image.worker.ts", import.meta.url), { type: "module" });
    this.held = [];
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      // the id the worker announces itself with (importing it would pull the engine into this bundle)
      if (e.data.id === -1) {
        for (const request of this.held ?? []) worker.postMessage(request);
        this.held = null;
        return;
      }
      const job = this.waiting.get(e.data.id);
      if (!job) return;
      this.waiting.delete(e.data.id);
      if (e.data.ok) job.resolve(e.data.result as never);
      else job.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      for (const job of this.waiting.values()) job.reject(new Error("The picture engine stopped. Please try again."));
      this.waiting.clear();
    };
    this.worker = worker;
    void this.send(worker, "open", [this.picture]).catch(() => {});
    for (const font of this.fonts) void this.send(worker, "addFont", font).catch(() => {});
    return worker;
  }

  private send<T>(worker: Worker, method: WorkerRequest["method"], args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.next++;
      this.waiting.set(id, { resolve, reject });
      const request: WorkerRequest = { id, method, args };
      if (this.held) this.held.push(request);
      else worker.postMessage(request);
    });
  }

  private call<T>(method: WorkerRequest["method"], ...args: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error("closed"));
    return this.send<T>(this.start(), method, args);
  }

  analyze = (box: TextBox, align: Align) => this.call<Analysis>("analyze", box, { align });
  render = (box: TextBox, edit: BoxEdit, align: Align) => this.call<RenderResult>("render", box, edit, { align });
  sample = (face: FaceRef, text: string, height: number) => this.call<FontSample>("sample", face, text, height);
  crop = (quad: Quad4) => this.call<Picture>("crop", quad);
  async addFont(name: string, bytes: Uint8Array): Promise<UploadedFont> {
    const font = await this.call<UploadedFont>("addFont", name, bytes);
    this.fonts.push([name, bytes]);
    return font;
  }

  dispose() {
    this.closed = true;
    this.worker?.terminate();
    this.worker = null;
    this.waiting.clear();
  }
}
