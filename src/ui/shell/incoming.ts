/**
 * Files handed to the app by the system: "Open with PDFEdit" on a computer (manifest file_handlers), and a
 * share from another app, which public/sw.js sets aside on this device until the app picks it up.
 */
import { openAnother } from "./actions";

const INBOX = "pdfedit-inbox";

interface LaunchParams {
  files?: { getFile(): Promise<File> }[];
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

/** shared files waiting on the device; they are removed as soon as they are read */
export async function takeShared(): Promise<File[]> {
  if (!("caches" in window) || !(await caches.has(INBOX))) return [];
  const cache = await caches.open(INBOX);
  const files: File[] = [];
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    if (!response) continue;
    const name = decodeURIComponent(response.headers.get("x-file-name") ?? "shared.pdf");
    const blob = await response.blob();
    files.push(new File([blob], name, { type: blob.type }));
  }
  await caches.delete(INBOX);
  return files;
}

let started = false;

/** once per visit: pick up what was shared, and listen for files opened with the app */
export function acceptIncomingFiles(): void {
  if (started) return;
  started = true;
  const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
  // asks first when there are unsaved changes
  queue?.setConsumer((params) => {
    if (!params.files?.length) return;
    void Promise.all(params.files.map((handle) => handle.getFile())).then((files) => openAnother(files));
  });
  if (new URLSearchParams(location.search).has("shared")) history.replaceState(history.state, "", location.pathname);
  void takeShared()
    .then((files) => (files.length ? openAnother(files) : undefined))
    .catch((e) => console.warn("shared files", e));
}
