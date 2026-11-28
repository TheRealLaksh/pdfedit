/**
 * Unsaved work that survives a closed or discarded tab: the same record the engine proxy keeps to rebuild
 * a crashed worker (the file and every change), written to IndexedDB as it grows. One draft, on this
 * device only. Passwords are never written, so protected files have no draft.
 */

export interface DraftStep {
  method: string;
  args: unknown[];
}

export interface DraftJournal {
  open: DraftStep;
  steps: DraftStep[];
  /** the file needed a password: nothing of it may be kept */
  protected?: boolean;
}

export interface DraftInfo {
  fileName: string;
  /** milliseconds since 1970 */
  savedAt: number;
  /** number of recorded changes (undo and redo included) */
  changes: number;
  bytes: number;
}

export interface DraftStorage {
  get(key: string): Promise<unknown>;
  /** write all entries in one transaction, emptying the store first when `clear` */
  write(entries: [string, unknown][], clear: boolean): Promise<void>;
}

export const DRAFT_LIMIT = 80 * 1024 * 1024;
export const DRAFT_DAYS = 7;

interface Meta extends DraftInfo {
  /** which journal the stored steps belong to (another tab may have taken over) */
  session: string;
  version: 1;
}

function indexedDbStorage(): DraftStorage | null {
  if (typeof indexedDB === "undefined") return null;
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("pdfedit-draft", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("draft");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => () => T): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction("draft", mode);
        const result = work(transaction.objectStore("draft"));
        transaction.oncomplete = () => resolve(result());
        transaction.onabort = transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: (key) =>
      run("readonly", (store) => {
        const request = store.get(key);
        return () => request.result as unknown;
      }),
    write: (entries, clear) =>
      run("readwrite", (store) => {
        if (clear) store.clear();
        for (const [key, value] of entries) store.put(value, key);
        return () => undefined;
      }),
  };
}

/** bytes carried by the arguments of a call */
function weigh(value: unknown, depth = 0): number {
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === "string") return value.length * 2;
  if (!value || typeof value !== "object" || depth > 6) return 8;
  return Object.values(value).reduce<number>((sum, v) => sum + weigh(v, depth + 1), 0);
}

/** calls that carry a password */
const hasPassword = (step: DraftStep) =>
  (step.method === "open" && step.args[2] !== undefined) || (step.method === "insertPdf" && !!step.args[2]);

export function createDraftKeeper(storage: DraftStorage | null = indexedDbStorage()) {
  let enabled = true;
  let paused = false;
  /** the journal whose first `written` steps are in storage */
  let mine: { open: DraftStep; session: string; written: number; bytes: number } | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const later = <T>(job: () => Promise<T>): Promise<T | undefined> => {
    const next = queue.then(job).catch((e) => {
      // private windows and full disks: editing goes on without a draft
      console.warn("The draft could not be saved", e);
      mine = null;
      return undefined;
    });
    queue = next;
    return next;
  };

  const meta = async (): Promise<Meta | null> => {
    const found = (await storage?.get("meta")) as Meta | undefined;
    return found?.version === 1 ? found : null;
  };
  const erase = async () => {
    mine = null;
    await storage?.write([], true);
  };

  const save = async (journal: DraftJournal) => {
    if (!storage) return;
    const owned = mine?.open === journal.open && (await meta())?.session === mine.session;
    if (journal.protected || [journal.open, ...journal.steps].some(hasPassword)) {
      // a draft of this very document (before a protected file was added to it) has to go
      if (owned) await erase();
      return;
    }
    // fonts alone are not work worth keeping, and an unchanged file must not replace an older draft
    if (!journal.steps.some((s) => s.method !== "addUserFont")) return;
    const from = owned && mine!.written <= journal.steps.length ? mine!.written : 0;
    const fresh = journal.steps.slice(from);
    const bytes = (from ? mine!.bytes : weigh(journal.open.args)) + fresh.reduce((n, s) => n + weigh(s.args), 0);
    if (bytes > DRAFT_LIMIT) {
      // an older state of this document would restore with work silently missing
      await erase();
      return;
    }
    const session = from ? mine!.session : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const info: Meta = {
      version: 1,
      session,
      fileName: String(journal.open.args[1] ?? "document.pdf"),
      savedAt: Date.now(),
      changes: journal.steps.filter((s) => s.method !== "addUserFont").length,
      bytes,
    };
    const entries: [string, unknown][] = [["meta", info]];
    if (!from) entries.push(["open", { method: journal.open.method, args: journal.open.args.slice(0, 2) }]);
    fresh.forEach((s, i) => entries.push([`step:${from + i}`, { method: s.method, args: s.args }]));
    await storage.write(entries, !from);
    mine = { open: journal.open, session, written: journal.steps.length, bytes };
  };

  return {
    /** call after every change of the journal */
    record(journal: DraftJournal): void {
      if (!enabled || paused) return;
      // the steps are copied now: the journal keeps growing while this waits its turn
      const now = { ...journal, steps: journal.steps.slice() };
      void later(() => save(now));
    },
    /** no writing while a draft is being replayed */
    pause(): void {
      paused = true;
    },
    /** carry on; `journal` replaces what is stored */
    resume(journal?: DraftJournal): void {
      paused = false;
      mine = null;
      if (journal) this.record(journal);
    },
    async info(): Promise<DraftInfo | null> {
      const found = await later(async () => {
        const m = await meta();
        if (!m) return null;
        if (Date.now() - m.savedAt > DRAFT_DAYS * 86_400_000) {
          await erase();
          return null;
        }
        return { fileName: m.fileName, savedAt: m.savedAt, changes: m.changes, bytes: m.bytes };
      });
      return found ?? null;
    },
    async read(): Promise<DraftJournal | null> {
      const found = await later(async () => {
        if (!(await meta())) return null;
        const open = (await storage!.get("open")) as DraftStep | undefined;
        if (!open) return null;
        const steps: DraftStep[] = [];
        for (let i = 0; ; i++) {
          const step = (await storage!.get(`step:${i}`)) as DraftStep | undefined;
          if (!step) break;
          steps.push(step);
        }
        return { open, steps };
      });
      return found ?? null;
    },
    async clear(): Promise<void> {
      await later(erase);
    },
    async setEnabled(on: boolean): Promise<void> {
      enabled = on;
      if (!on) await later(erase);
    },
    /** resolves when everything asked for has been written */
    settled: (): Promise<unknown> => queue,
  };
}

export type DraftKeeper = ReturnType<typeof createDraftKeeper>;
