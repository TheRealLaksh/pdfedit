/**
 * Holds page requests back while the document is being closed or replaced. The engine answers in order,
 * so a request posted behind `close` finds no document, and one posted behind `open` finds the wrong one.
 * Neither action changes any state before it calls the engine, so the store actions are wrapped here.
 */
import { useStore } from "../../store";

let changing = 0;
const waiting = new Set<() => void>();

export const documentChanging = () => changing > 0;

/** runs `listener` once, when the document has settled */
export function whenSettled(listener: () => void) {
  if (changing) waiting.add(listener);
  else listener();
}

/** is a request made for `session` still worth sending or answering? */
export function isCurrent(session: number): boolean {
  const state = useStore.getState();
  return state.session === session && state.doc !== null;
}

async function hold<T>(work: () => Promise<T>): Promise<T> {
  changing++;
  try {
    return await work();
  } finally {
    if (--changing === 0) {
      const ready = [...waiting];
      waiting.clear();
      for (const listener of ready) listener();
    }
  }
}

const { closeDoc, openBytes, openFiles } = useStore.getState();
useStore.setState({
  closeDoc: () => hold(closeDoc),
  openBytes: (...args) => hold(() => openBytes(...args)),
  openFiles: (files) => hold(() => openFiles(files)),
});
