/** Cached per page, per revision engine queries (text lines, added objects, existing images). */
import { useEffect, useState } from "react";
import { engine } from "../../engine/client";
import type { DocInfo, FormField, ImageItem, PageObject, PageText } from "../../engine/types";
import { useStore } from "../../store";
import { isCurrent, whenSettled } from "./documentGate";

interface Kinds {
  text: PageText;
  objects: PageObject[];
  images: ImageItem[];
  fields: FormField[];
}

export type PageDataKind = keyof Kinds;

const loaders: { [K in keyof Kinds]: (page: number) => Promise<Kinds[K]> } = {
  text: (page) => engine.getPageText(page),
  objects: (page) => engine.listObjects(page),
  images: (page) => engine.listImages(page),
  fields: (page) => loadFields().then((all) => all.filter((f) => f.page === page)),
};

/** the engine lists the fields of the whole document: asked once per state of it */
let fields: { doc: DocInfo | null; all: Promise<FormField[]> } | null = null;

export function loadFields(): Promise<FormField[]> {
  const doc = useStore.getState().doc;
  if (!doc?.hasForms) return Promise.resolve([]);
  if (fields?.doc !== doc) {
    const all = engine.listFormFields();
    fields = { doc, all };
    all.catch(() => (fields = null));
  }
  return fields.all;
}

const LIMIT = 240;
const cache = new Map<string, Promise<unknown>>();
const values = new Map<string, unknown>();

const keyOf = (kind: keyof Kinds, session: number, page: number, revision: number) =>
  `${session}:${kind}:${page}:${revision}`;

export function loadPageData<K extends keyof Kinds>(kind: K, page: number): Promise<Kinds[K]> {
  const { session, doc } = useStore.getState();
  const revision = doc?.pages[page]?.revision ?? -1;
  const key = keyOf(kind, session, page, revision);
  let p = cache.get(key) as Promise<Kinds[K]> | undefined;
  if (!p) {
    p = request(kind, page, session);
    cache.set(key, p);
    p.then(
      (v) => cache.has(key) && values.set(key, v),
      () => cache.delete(key),
    );
    if (cache.size > LIMIT) {
      const oldest = cache.keys().next().value!;
      cache.delete(oldest);
      values.delete(oldest);
    }
  }
  return p;
}

/**
 * Ask the engine, unless the document is being closed or replaced. A request that has become stale never
 * settles: whoever asked belongs to the old document and is gone.
 */
function request<K extends keyof Kinds>(kind: K, page: number, session: number): Promise<Kinds[K]> {
  return new Promise((resolve, reject) => {
    whenSettled(() => {
      if (!isCurrent(session)) return;
      loaders[kind](page).then(
        (value) => isCurrent(session) && resolve(value),
        (error: unknown) => isCurrent(session) && reject(error),
      );
    });
  });
}

export function peekPageData<K extends keyof Kinds>(kind: K, page: number): Kinds[K] | undefined {
  const { session, doc } = useStore.getState();
  return values.get(keyOf(kind, session, page, doc?.pages[page]?.revision ?? -1)) as Kinds[K] | undefined;
}

export interface PageData<T> {
  /** data for the current revision, if loaded */
  data: T | undefined;
  /** the last loaded data, possibly of an older revision (avoids flicker) */
  last: T | undefined;
  error: string | null;
  retry(): void;
}

export function usePageData<K extends keyof Kinds>(kind: K, page: number, enabled: boolean): PageData<Kinds[K]> {
  const session = useStore((s) => s.session);
  const revision = useStore((s) => s.doc?.pages[page]?.revision ?? -1);
  const key = keyOf(kind, session, page, revision);
  const [state, setState] = useState<{ key: string; session: number; data?: Kinds[K]; error: string | null }>(() => ({
    key: "",
    session,
    error: null,
  }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || revision < 0) return;
    let live = true;
    const load = () =>
      loadPageData(kind, page).then(
        (data) => live && setState({ key, session, data, error: null }),
        (e: unknown) =>
          live && setState((s) => ({ ...s, key, error: e instanceof Error ? e.message : String(e) })),
      );
    // the engine answers one request at a time: pages merely flying past must not queue ahead of renders
    const timer = cache.has(key) ? (void load(), undefined) : setTimeout(load, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [kind, page, enabled, key, session, revision, attempt]);

  const current = (values.get(key) as Kinds[K] | undefined) ?? (state.key === key && !state.error ? state.data : undefined);
  return {
    data: enabled ? current : undefined,
    last: enabled ? (current ?? (state.session === session ? state.data : undefined)) : undefined,
    error: state.key === key ? state.error : null,
    retry: () => setAttempt((n) => n + 1),
  };
}
