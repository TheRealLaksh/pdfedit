/** State of the image editor: the picture, its boxes and edits with undo, and the pixels they produce. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { recognizePage } from "../../ocr";
import { useStore } from "../../store";
import { ImageClient } from "../client";
import { detectText, guessAlign } from "../detect";
import { S } from "../strings";
import type { Analysis, BoxEdit, LineStyle, Patch, Quad4, RenderResult, TextBox } from "../types";
import { openPicture, type Opened } from "./picture";

export interface Doc {
  boxes: TextBox[];
  edits: Record<string, BoxEdit>;
}

interface History {
  past: Doc[];
  now: Doc;
  future: Doc[];
  /** changes with the same tag made in quick succession undo together */
  tag: string;
  time: number;
}

export type Reading = { state: "running"; status: string; progress: number } | { state: "done"; count: number } | { state: "failed"; message: string };

const empty: Doc = { boxes: [], edits: {} };
const start = (): History => ({ past: [], now: empty, future: [], tag: "", time: 0 });
const signature = (box: TextBox, edit: BoxEdit) => JSON.stringify([box.quad, box.text, box.source, !!box.checked, edit]);
export const analysisKey = (box: TextBox) => JSON.stringify([box.id, box.quad, box.text, box.source, !!box.checked]);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** an edit that asks for nothing is no edit */
function tidy(edit: BoxEdit): BoxEdit | undefined {
  const out = { ...edit };
  if (out.style && !Object.keys(out.style).length) delete out.style;
  if (out.move && Math.abs(out.move[0]) < 0.5 && Math.abs(out.move[1]) < 0.5) delete out.move;
  return out.text === undefined && !out.style && out.align === undefined && out.keep === undefined && !out.move ? undefined : out;
}

export function useEditor(file: File) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<History>(start);
  const [reading, setReading] = useState<Reading>({ state: "running", status: S.reading, progress: 0 });
  const [analyses, setAnalyses] = useState<Record<string, Analysis>>({});
  const [renders, setRenders] = useState<Record<string, RenderResult>>({});
  const [pending, setPending] = useState(0);
  const [saved, setSaved] = useState<Doc | null>(null);
  const client = useRef<ImageClient | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** what the last reading found the picture to be written in */
  const readLanguages = useRef<string[]>([]);
  const doc = history.now;
  const latest = useRef(doc);
  latest.current = doc;

  const read = useCallback(async (o: Opened, languages: string[]) => {
    abort.current?.abort();
    const run = (abort.current = new AbortController());
    setReading({ state: "running", status: S.reading, progress: 0 });
    try {
      const { boxes, languages: found } = await detectText(o.picture, recognizePage, {
        languages,
        signal: run.signal,
        onProgress: (status, progress) => {
          if (!run.signal.aborted) setReading({ state: "running", status, progress });
        },
      });
      if (run.signal.aborted) return;
      readLanguages.current = found;
      // boxes drawn by hand stay; recognised ones are replaced
      const id = Date.now().toString(36);
      setHistory((h) => {
        const mine = h.now.boxes.filter((b) => b.source === "manual");
        return { ...start(), now: { boxes: [...boxes.map((b) => ({ ...b, id: `${b.id}-${id}` })), ...mine], edits: Object.fromEntries(Object.entries(h.now.edits).filter(([k]) => mine.some((b) => b.id === k))) } };
      });
      setReading({ state: "done", count: boxes.length });
    } catch (e) {
      if (!run.signal.aborted) setReading({ state: "failed", message: message(e) });
    }
  }, []);

  useEffect(() => {
    let gone = false;
    let bitmap: ImageBitmap | null = null;
    void openPicture(file)
      .then((o) => {
        if (gone) return o.bitmap.close();
        bitmap = o.bitmap;
        client.current = new ImageClient(o.picture);
        setOpened(o);
        if (o.scaled) useStore.getState().toast(S.scaled(o.picture.width, o.picture.height), "info");
        void read(o, useStore.getState().ocr.languages);
      })
      .catch(() => !gone && setError(S.openFailed));
    return () => {
      gone = true;
      abort.current?.abort();
      client.current?.dispose();
      client.current = null;
      bitmap?.close();
    };
  }, [file, read]);

  const change = useCallback((tag: string, next: (d: Doc) => Doc) => {
    setHistory((h) => {
      const now = next(h.now);
      if (now === h.now) return h;
      const together = tag !== "" && tag === h.tag && Date.now() - h.time < 1500;
      return { past: together ? h.past : [...h.past.slice(-199), h.now], now, future: [], tag, time: Date.now() };
    });
  }, []);

  const undo = useCallback(() => setHistory((h) => (h.past.length ? { past: h.past.slice(0, -1), now: h.past.at(-1)!, future: [h.now, ...h.future], tag: "", time: 0 } : h)), []);
  const redo = useCallback(() => setHistory((h) => (h.future.length ? { past: [...h.past, h.now], now: h.future[0]!, future: h.future.slice(1), tag: "", time: 0 } : h)), []);

  const setEdit = useCallback(
    (id: string, patch: Partial<BoxEdit>, tag: string) =>
      change(`${tag}:${id}`, (d) => {
        const edit = tidy({ ...d.edits[id], ...patch });
        const edits = { ...d.edits };
        if (edit) edits[id] = edit;
        else delete edits[id];
        return { ...d, edits };
      }),
    [change],
  );
  const setStyle = useCallback(
    (id: string, style: Partial<LineStyle>) =>
      change(`style:${Object.keys(style).join()}:${id}`, (d) => ({ ...d, edits: { ...d.edits, [id]: { ...d.edits[id], style: { ...d.edits[id]?.style, ...style } } } })),
    [change],
  );
  const setBox = useCallback(
    (id: string, patch: Partial<TextBox>, tag: string) => change(`${tag}:${id}`, (d) => ({ ...d, boxes: d.boxes.map((b) => (b.id === id ? { ...b, ...patch } : b)) })),
    [change],
  );
  const addBox = useCallback(
    (quad: Quad4) => {
      const box: TextBox = { id: `m${Date.now().toString(36)}`, quad, text: "", source: "manual" };
      change("", (d) => ({ ...d, boxes: [...d.boxes, box] }));
      return box.id;
    },
    [change],
  );
  const removeBox = useCallback(
    (id: string) =>
      change("", (d) => {
        const edits = { ...d.edits };
        delete edits[id];
        return { boxes: d.boxes.filter((b) => b.id !== id), edits };
      }),
    [change],
  );

  const alignOf = useCallback((box: TextBox) => guessAlign(box, latest.current.boxes, opened?.picture.width ?? 1), [opened]);

  /* ---------- analysis ---------- */
  const asked = useRef(new Set<string>());
  const analyze = useCallback(
    (box: TextBox) => {
      const key = analysisKey(box);
      if (asked.current.has(key) || !client.current) return;
      asked.current.add(key);
      setPending((n) => n + 1);
      client.current
        .analyze(box, alignOf(box))
        .then((a) => setAnalyses((all) => ({ ...all, [key]: a })))
        .catch((e) => {
          asked.current.delete(key);
          if (message(e) !== "closed") useStore.getState().toast(`${S.failed}: ${message(e)}`, "error");
        })
        .finally(() => setPending((n) => n - 1));
    },
    [alignOf],
  );

  /* ---------- rendering ---------- */
  const done = useRef(new Map<string, string>());
  const busy = useRef(new Set<string>());
  const pump = useCallback(() => {
    const now = latest.current;
    for (const [id, edit] of Object.entries(now.edits)) {
      const box = now.boxes.find((b) => b.id === id);
      if (!box || busy.current.has(id) || !client.current) continue;
      const wanted = signature(box, edit);
      if (done.current.get(id) === wanted) continue;
      busy.current.add(id);
      setPending((n) => n + 1);
      client.current
        .render(box, edit, alignOf(box))
        .then((result) => {
          done.current.set(id, wanted);
          setRenders((all) => ({ ...all, [id]: result }));
        })
        .catch((e) => {
          done.current.set(id, wanted);
          if (message(e) !== "closed") useStore.getState().toast(`${S.failed}: ${message(e)}`, "error");
        })
        .finally(() => {
          busy.current.delete(id);
          setPending((n) => n - 1);
          // what was typed meanwhile
          pump();
        });
    }
  }, [alignOf]);

  useEffect(() => {
    for (const id of done.current.keys()) if (!doc.edits[id]) done.current.delete(id);
    setRenders((all) => {
      const gone = Object.keys(all).filter((id) => !doc.edits[id]);
      if (!gone.length) return all;
      const next = { ...all };
      for (const id of gone) delete next[id];
      return next;
    });
    pump();
  }, [doc, pump]);

  const patches = useMemo<Patch[]>(
    () => Object.keys(doc.edits).flatMap((id) => (renders[id]?.patch ? [renders[id]!.patch!] : [])),
    [doc.edits, renders],
  );

  return {
    opened,
    error,
    doc,
    reading,
    analyses,
    renders,
    patches,
    working: pending > 0,
    readLanguages,
    dirty: patches.length > 0 && saved !== doc,
    markSaved: () => setSaved(latest.current),
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    client,
    undo,
    redo,
    setEdit,
    setStyle,
    setBox,
    addBox,
    removeBox,
    analyze,
    readAgain: (languages: string[]) => {
      if (!opened) return;
      setHistory((h) => {
        const mine = h.now.boxes.filter((b) => b.source === "manual");
        return { ...h, now: { boxes: mine, edits: Object.fromEntries(Object.entries(h.now.edits).filter(([k]) => mine.some((b) => b.id === k))) } };
      });
      void read(opened, languages);
    },
    stopReading: () => {
      abort.current?.abort();
      setReading({ state: "done", count: latest.current.boxes.length });
    },
  };
}

export type Editor = ReturnType<typeof useEditor>;
