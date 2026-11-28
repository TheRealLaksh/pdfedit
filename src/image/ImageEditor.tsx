/** Edit the text inside a picture. Owner: IMAGE module. */
import { ArrowUUpLeft, ArrowUUpRight, Export, Eye, FilePdf, Plus, Translate, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { UploadedFont } from "./client";
import { familyByKey } from "./fonts/catalog";
import { rectQuad } from "./geometry";
import { S } from "./strings";
import type { Quad4 } from "./types";
import "./ui/image.css";
import { Panel } from "./ui/Panel";
import { exportPicture } from "./ui/picture";
import { Dialog, ExportSheet, FontSheet, LanguageSheet } from "./ui/Sheets";
import { Stage, type Mode } from "./ui/Stage";
import { analysisKey, useEditor } from "./ui/useEditor";

type Sheet = "export" | "fonts" | "languages" | "leave" | null;

/** the editor fills exactly what is visible, so that an on-screen keyboard never covers the text */
function useVisibleArea() {
  const [area, setArea] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // pinching the whole page is not a keyboard
      if (vv.scale > 1.01) return setArea(null);
      setArea({ top: Math.round(vv.offsetTop), height: Math.round(vv.height) });
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return area;
}

export function ImageEditor({ file, onClose }: { file: File; onClose: () => void }) {
  const editor = useEditor(file);
  const { opened, doc, reading } = editor;
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("select");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [compare, setCompare] = useState(false);
  const [uploaded, setUploaded] = useState<UploadedFont[]>([]);
  const [readingBox, setReadingBox] = useState<string | null>(null);
  const area = useVisibleArea();

  const box = doc.boxes.find((b) => b.id === selected);
  const analysis = box ? editor.analyses[analysisKey(box)] : undefined;
  // while a corrected text or moved corner is being measured, the last measurement stays on screen
  const last = useRef(new Map<string, NonNullable<typeof analysis>>());
  if (box && analysis) last.current.set(box.id, analysis);
  const shownAnalysis = analysis ?? (box ? last.current.get(box.id) : undefined);

  const { analyze } = editor;
  useEffect(() => {
    if (box && box.text && !analysis) analyze(box);
  }, [box, analysis, analyze]);

  useEffect(() => {
    if (selected && !box) setSelected(null);
  }, [selected, box]);

  const select = useCallback((id: string | null) => {
    if (!id) (document.activeElement as HTMLElement | null)?.blur?.();
    setSelected(id);
    setMode("select");
  }, []);

  /** read the words inside a box drawn by hand */
  const { client, setBox, readLanguages } = editor;
  const readBox = useCallback(
    async (id: string, quad: Quad4) => {
      if (!client.current) return;
      setReadingBox(id);
      try {
        const crop = await client.current.crop(quad);
        const { recognizePage } = await import("../ocr");
        const chosen = useStore.getState().ocr.languages;
        // a few words are too little to tell the language from: go by what the whole picture was read as
        const result = await recognizePage({ page: 0, revision: 0, ...crop }, { languages: chosen.length ? chosen : readLanguages.current, scale: 300 / 72 });
        const text = result.lines.map((l) => l.text).join(" ").trim();
        if (text) setBox(id, { text }, "read");
      } catch {
        useStore.getState().toast(S.readFailed, "warning");
      } finally {
        setReadingBox((now) => (now === id ? null : now));
      }
    },
    [client, setBox, readLanguages],
  );

  const close = () => (editor.dirty ? setSheet("leave") : onClose());

  const makePdf = async () => {
    try {
      const picture = editor.patches.length && opened ? await exportPicture(opened.bitmap, editor.patches, "image/png", 1, file.name.replace(/\.[^.]+$/, "")) : file;
      await useStore.getState().openImagesAsPdf([picture]);
    } catch (e) {
      useStore.getState().toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  useEffect(() => {
    const before = document.title;
    document.title = `${file.name} · PDFEdit`;
    return () => {
      document.title = before;
    };
  }, [file.name]);

  useEffect(() => {
    if (!editor.dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editor.dirty]);

  // Back on a phone takes away one layer at a time instead of leaving the page with the changes
  const layers = useRef({ sheet, selected, dirty: editor.dirty });
  layers.current = { sheet, selected, dirty: editor.dirty };
  const guarded = !!sheet || !!selected || editor.dirty;
  useEffect(() => {
    if (guarded && !history.state?.pdfeditImage) history.pushState({ pdfeditImage: true }, "");
  }, [guarded]);
  useEffect(() => {
    const back = (event: PopStateEvent) => {
      if ((event.state as { pdfeditImage?: boolean } | null)?.pdfeditImage) return;
      const now = layers.current;
      if (!now.sheet && !now.selected && !now.dirty) return;
      if (now.sheet) setSheet(null);
      else if (now.selected) select(null);
      else setSheet("leave");
      setTimeout(() => history.pushState({ pdfeditImage: true }, ""));
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [select]);

  const { undo, redo } = editor;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (layers.current.sheet) return;
      const typing = (e.target as HTMLElement).matches?.("input[type=text], input[type=search], textarea");
      const command = e.ctrlKey || e.metaKey;
      if (command && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (command && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (command && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setSheet("export");
      } else if (e.key === "Escape") select(null);
      else if (!typing && e.key === "\\") setCompare(true);
    };
    const release = (e: KeyboardEvent) => e.key === "\\" && setCompare(false);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", release);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", release);
    };
  }, [undo, redo, select]);

  const fontName = (key: string) => familyByKey(key)?.name ?? uploaded.find((u) => u.key === key)?.family ?? key;
  const edit = box ? (doc.edits[box.id] ?? {}) : {};
  const style = shownAnalysis ? { ...shownAnalysis.style, ...edit.style } : null;

  return (
    <div className="im-app" style={area ? { top: area.top, height: area.height } : undefined} data-selected={box ? true : undefined} data-working={editor.working || undefined}>
      <header className="im-top">
        <button type="button" className="im-icon" aria-label={S.close} title={S.close} onClick={close}>
          <X size={22} aria-hidden />
        </button>
        <h1 title={file.name}>{file.name}</h1>
        <button type="button" className="im-icon" aria-label={S.undo} title={S.undo} disabled={!editor.canUndo} onClick={editor.undo}>
          <ArrowUUpLeft size={22} aria-hidden />
        </button>
        <button type="button" className="im-icon" aria-label={S.redo} title={S.redo} disabled={!editor.canRedo} onClick={editor.redo}>
          <ArrowUUpRight size={22} aria-hidden />
        </button>
        <button
          type="button"
          className="im-icon"
          aria-label={S.compare}
          title={S.compare}
          aria-pressed={compare}
          disabled={!editor.patches.length}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setCompare(true);
          }}
          onPointerUp={() => setCompare(false)}
          onPointerCancel={() => setCompare(false)}
          onKeyDown={(e) => (e.key === " " || e.key === "Enter") && setCompare(true)}
          onKeyUp={() => setCompare(false)}
          onBlur={() => setCompare(false)}
          onContextMenu={(e) => e.preventDefault()}
        >
          <Eye size={22} aria-hidden />
        </button>
        <button type="button" className="im-btn im-primary" disabled={!opened} onClick={() => setSheet("export")}>
          <Export size={18} aria-hidden />
          <span>{S.export}</span>
        </button>
      </header>

      <main className="im-main">
        {opened ? (
          <Stage
            opened={opened}
            boxes={doc.boxes}
            edited={doc.edits}
            renders={editor.renders}
            patches={editor.patches}
            selected={selected}
            mode={mode}
            compare={compare}
            onMoveText={(id, delta) => {
              const from = editor.doc.edits[id]?.move ?? [0, 0];
              editor.setEdit(id, { move: [from[0] + delta[0], from[1] + delta[1]] }, "move");
            }}
            selectedQuad={box ? (editor.renders[box.id]?.quad ?? (box.source === "ocr" ? (shownAnalysis?.quad ?? box.quad) : box.quad)) : null}
            onSelect={select}
            onDraw={(quad) => {
              const id = editor.addBox(quad);
              select(id);
              void readBox(id, quad);
            }}
            onPick={(color) => {
              if (box) editor.setStyle(box.id, { color });
              setMode("select");
            }}
            onCorners={(id, quad) => editor.setBox(id, { quad: quad.map((p) => [...p]) as Quad4, source: "manual" }, "corners")}
          />
        ) : (
          <div className="im-wait" role={editor.error ? "alert" : "status"}>
            {editor.error ?? <span className="im-spin">{S.opening}</span>}
          </div>
        )}
        {(mode !== "select" || compare) && (
          <div className="im-banner" role="status">
            {compare ? S.compare : mode === "draw" ? S.drawHint : S.pickHint}
            {!compare && (
              <button type="button" className="im-btn" onClick={() => setMode("select")}>
                {S.cancel}
              </button>
            )}
            {mode === "draw" && !compare && opened && (
              // without a pointer: a box in the middle, adjusted by its corners
              <button
                type="button"
                className="im-btn"
                onClick={() => {
                  const { width, height } = opened.picture;
                  select(editor.addBox(rectQuad(width * 0.3, height * 0.46, width * 0.7, height * 0.54)));
                }}
              >
                {S.placeInMiddle}
              </button>
            )}
          </div>
        )}
      </main>

      <aside className="im-panel" aria-label={S.tabText}>
        {box ? (
          <Panel
            key={box.id}
            box={box}
            edit={edit}
            analysis={shownAnalysis}
            render={editor.renders[box.id]}
            fontName={fontName}
            onEdit={(patch, tag) => editor.setEdit(box.id, patch, tag)}
            onStyle={(s) => editor.setStyle(box.id, s)}
            onResetStyle={() => editor.setEdit(box.id, { style: undefined }, "")}
            onSays={(text) => editor.setBox(box.id, { text, checked: true }, "says")}
            onUseAsNew={(reading, text) => {
              editor.setBox(box.id, { text: reading, checked: false }, "says-back");
              editor.setEdit(box.id, { text }, "says-new");
            }}
            onReadBox={() => void readBox(box.id, box.quad)}
            reading={readingBox === box.id}
            picking={mode === "pick"}
            onPickColour={() => setMode(mode === "pick" ? "select" : "pick")}
            onFonts={() => setSheet("fonts")}
            onDeleteBox={() => {
              editor.removeBox(box.id);
              select(null);
            }}
            onDone={() => select(null)}
          />
        ) : (
          <div className="im-overview">
            <div className="im-status" role="status">
              {reading.state === "running" ? (
                <>
                  <span className="im-spin">
                    {reading.status} {Math.round(reading.progress * 100)}%
                  </span>
                  <progress max={1} value={reading.progress} aria-label={S.reading} />
                  <button type="button" className="im-btn" onClick={editor.stopReading}>
                    {S.cancel}
                  </button>
                </>
              ) : reading.state === "failed" ? (
                <>
                  <p className="im-error">
                    {S.readFailed}: {reading.message}
                  </p>
                  <button type="button" className="im-btn" onClick={() => editor.readAgain(useStore.getState().ocr.languages)}>
                    {S.retry}
                  </button>
                </>
              ) : (
                <p>{S.found(doc.boxes.length)}</p>
              )}
            </div>
            <div className="im-actions">
              <button type="button" className="im-btn" disabled={!opened} aria-pressed={mode === "draw"} onClick={() => setMode(mode === "draw" ? "select" : "draw")}>
                <Plus size={18} aria-hidden />
                {S.addArea}
              </button>
              <button type="button" className="im-btn" disabled={!opened} onClick={() => setSheet("languages")}>
                <Translate size={18} aria-hidden />
                {S.languages}
              </button>
              <button type="button" className="im-btn" disabled={!opened} onClick={() => void makePdf()}>
                <FilePdf size={18} aria-hidden />
                {S.makePdf}
              </button>
            </div>
            {doc.boxes.length > 0 && (
              <ul className="im-list">
                {doc.boxes.map((b) => (
                  <li key={b.id}>
                    <button type="button" dir="auto" data-edited={doc.edits[b.id] ? true : undefined} onClick={() => select(b.id)}>
                      {doc.edits[b.id]?.text ?? (b.text || S.boxLabel(""))}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </aside>

      {sheet === "export" && opened && (
        <ExportSheet
          bitmap={opened.bitmap}
          patches={editor.patches}
          fileName={file.name}
          sourceType={file.type}
          working={editor.working}
          onSaved={editor.markSaved}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "languages" && <LanguageSheet changed={Object.keys(doc.edits).length > 0} onRead={editor.readAgain} onClose={() => setSheet(null)} />}
      {sheet === "fonts" && box && shownAnalysis && style && client.current && (
        <FontSheet
          client={client.current}
          analysis={shownAnalysis}
          style={style}
          text={edit.text ?? box.text}
          uploaded={uploaded}
          onPick={(s) => {
            // a newly chosen face is fitted to the old letters again
            const kept = { ...edit.style, ...s };
            delete kept.size;
            delete kept.stretch;
            editor.setEdit(box.id, { style: kept }, "font");
          }}
          onUpload={(picked) => {
            void picked
              .arrayBuffer()
              .then((b) => client.current!.addFont(picked.name, new Uint8Array(b)))
              .then((font) => setUploaded((all) => [...all.filter((u) => u.key !== font.key), font]))
              .catch((e) => useStore.getState().toast(`${S.badFont}: ${e instanceof Error ? e.message : String(e)}`, "error"));
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "leave" && (
        <Dialog
          title={S.leaveTitle}
          onClose={() => setSheet(null)}
          actions={
            <>
              <button type="button" className="im-btn" onClick={() => setSheet(null)}>
                {S.keepEditing}
              </button>
              <button type="button" className="im-btn im-danger" onClick={onClose}>
                {S.discard}
              </button>
            </>
          }
        >
          <p>{S.leaveBody}</p>
        </Dialog>
      )}
    </div>
  );
}
