/** The editor for one line (or one new/added text box): owns the draft and commits only what changed. */
import { ArrowsOutCardinalIcon, CheckIcon, XIcon } from "@phosphor-icons/react";
import { useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { engine } from "../../../engine/client";
import type { Align, LineEdit, PageObject, Point, Rect, TextLine, TextStyle } from "../../../engine/types";
import { useStore } from "../../../store";
import { ViewerContext } from "../context";
import { useCompact } from "../device";
import { fromLocal, lineFrame, MAX_SCALE } from "../geometry";
import { samplePaper } from "../canvasRegistry";
import { loadPageData, peekPageData } from "../pageData";
import { zoomAt } from "../viewerApi";
import { addGhost, removeGhost, useViewer, type TextDraft } from "../viewerStore";
import { editKey, editors, focusField, forgetTap, type ActiveEditor } from "./controller";
import { Dock } from "./Dock";
import { lineBox, Preview, type PreviewSpec } from "./Preview";
import { PhoneBar } from "./PhoneBar";
import { StyleBar, type StyleBarProps } from "./StyleBar";
import { measureText, offsetAtX } from "./textMetrics";

type TextObject = Extract<PageObject, { kind: "text" }>;
type Source =
  | { kind: "line"; line: TextLine }
  | { kind: "new"; draft: TextDraft; style: TextStyle; align: Align }
  | { kind: "object"; object: TextObject };

const LINE_HEIGHT = 1.2;
/** reference scale for scale independent measurements */
const REF = 10;

function findSource(page: number, lineId: string): Source | undefined {
  if (lineId.startsWith("new:")) {
    const draft = useViewer.getState().draft;
    const text = useStore.getState().toolOptions.text;
    return draft?.key === lineId ? { kind: "new", draft, style: text, align: "left" } : undefined;
  }
  if (lineId.startsWith("object:")) {
    const id = lineId.slice(7);
    const object = peekPageData("objects", page)?.find((o) => o.id === id);
    return object?.kind === "text" ? { kind: "object", object } : undefined;
  }
  const line = peekPageData("text", page)?.lines.find((l) => l.id === lineId);
  return line ? { kind: "line", line } : undefined;
}

export function TextEditor({ page, lineId, scale }: { page: number; lineId: string; scale: number }) {
  const session = useStore((s) => s.session);
  const key = editKey(session, page, lineId);
  const [loaded, setLoaded] = useState<{ key: string; source: Source; revision: number } | null>(() => {
    const source = findSource(page, lineId);
    return source ? { key, source, revision: useStore.getState().doc!.pages[page]!.revision } : null;
  });
  const current = loaded?.key === key ? loaded : null;

  useEffect(() => {
    if (current) return;
    let live = true;
    const revision = useStore.getState().doc?.pages[page]?.revision ?? 0;
    const done = () => {
      if (!live) return;
      const source = findSource(page, lineId);
      if (source) setLoaded({ key, source, revision });
      else useStore.getState().stopEditing();
    };
    loadPageData(lineId.startsWith("object:") ? "objects" : "text", page).then(done, done);
    return () => {
      live = false;
    };
  }, [current, key, page, lineId]);

  return current ? (
    <Session key={key} id={key} page={page} lineId={lineId} source={current.source} revision={current.revision} scale={scale} />
  ) : null;
}

interface Draft {
  text: string;
  patch: Partial<TextStyle>;
  align: Align;
  offset: Point;
  shrink: boolean;
}

function initialDraft(source: Source): { draft: Draft; style: TextStyle } {
  const base = { patch: {}, offset: [0, 0] as Point, shrink: false };
  if (source.kind === "line")
    return { draft: { ...base, text: source.line.text, align: source.line.align }, style: source.line.style };
  if (source.kind === "object")
    return { draft: { ...base, text: source.object.text, align: source.object.align }, style: source.object.style };
  return { draft: { ...base, text: "", align: source.align }, style: source.style };
}

function changedStyle(original: TextStyle, patch: Partial<TextStyle>): Partial<TextStyle> {
  const out: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(patch)) {
    const before = original[k as keyof TextStyle];
    const same =
      k === "underline"
        ? !!before === !!value
        : k === "color"
          ? (value as number[]).every((c, i) => Math.abs(c - (before as number[])[i]!) < 0.002)
          : before === value;
    if (!same && !(k === "fontChoice" && value === undefined && before === undefined)) out[k] = value;
  }
  return out as Partial<TextStyle>;
}

function Session({ id, page, lineId, source, revision, scale }: {
  id: string;
  page: number;
  lineId: string;
  source: Source;
  revision: number;
  scale: number;
}) {
  const compact = useCompact();
  const { root, scroller } = useContext(ViewerContext);
  const [docSession] = useState(() => useStore.getState().session);
  const pageWidth = useStore((s) => s.doc?.pages[page]?.width ?? 600);
  const currentRevision = useStore((s) => s.doc?.pages[page]?.revision);

  const [initial] = useState(() => initialDraft(source));
  const [draft, setDraft] = useState(initial.draft);
  const [short, setShort] = useState(false);
  const [tiny, setTiny] = useState(false);
  const [moving, setMoving] = useState(false);
  /** where on the line (points along it) the finger that opened the editor was */
  const [tappedAt] = useState(() => (editors.caret?.key === id ? editors.caret.u : null));
  const field = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const finished = useRef(false);

  const original = initial.style;
  const patch = changedStyle(original, draft.patch);
  const style: TextStyle = { ...original, ...patch };
  const fontFamily = useChoiceFamily(patch.fontChoice);
  const shown: TextStyle = fontFamily ? { ...style, family: fontFamily } : style;

  const [geometry] = useState(() => {
    if (source.kind === "line") {
      const { line } = source;
      const frame = lineFrame(line);
      const natural = measureText(line.text, line.style, line.style.size * REF).width +
        (line.style.letterSpacing ?? 0) * REF * [...line.text].length;
      const width = (frame.uMax - frame.uMin) * REF;
      const scaleX = line.text.trim() && natural > 1 ? Math.min(1.8, Math.max(0.55, width / natural)) : 1;
      return { frame, scaleX, cover: samplePaper(page, pageWidth, line.rect) };
    }
    if (source.kind === "object") return { cover: samplePaper(page, pageWidth, source.object.rect) };
    // phones: a new box wraps within what the screen shows (at the zoom it will be typed at)
    const typedAt = Math.max(scale, original.size * scale < 12 ? 15 / original.size : 0);
    const screen = compact ? scroller.current?.clientWidth : undefined;
    return { cover: null, maxWidth: screen ? (screen - 48) / typedAt : undefined };
  });

  /* ---------- what is drawn over the page ---------- */

  const blockRect = (): Rect => {
    if (source.kind === "object") {
      const r = source.object.rect;
      const h = box.current ? box.current.offsetHeight / scale : r[3] - r[1];
      return [r[0], r[1], r[2], r[1] + Math.max(r[3] - r[1], h)];
    }
    const r = (source as Extract<Source, { kind: "new" }>).draft.rect;
    const widest = Math.max(0, ...draft.text.split("\n").map((t) => measureText(t, shown, shown.size * REF).width / REF));
    const max = Math.max(60, Math.min(pageWidth - r[0] - 4, geometry.maxWidth ?? Infinity));
    const width = Math.min(max, Math.max(Math.min(120, max), widest * 1.12 + shown.size * 0.8));
    const lines = draft.text.split("\n").length;
    const h = box.current ? box.current.offsetHeight / scale : lines * shown.size * LINE_HEIGHT;
    return [r[0], r[1], r[0] + width, r[1] + h];
  };

  const spec: PreviewSpec =
    source.kind === "line"
      ? {
          kind: "line",
          frame: geometry.frame!,
          scaleX: patch.fontChoice ? 1 : geometry.scaleX!,
          shrink: draft.shrink,
          bleed: source.line.source === "ocr" ? 0.18 : 0,
          text: draft.text,
          style: shown,
          align: draft.align,
          offset: draft.offset,
          cover: geometry.cover,
        }
      : {
          kind: "block",
          rect: blockRect(),
          rotation: source.kind === "object" ? (source.object.rotation ?? 0) : 0,
          lineHeight: source.kind === "object" ? (source.object.lineHeight ?? LINE_HEIGHT) : LINE_HEIGHT,
          text: draft.text,
          style: shown,
          align: draft.align,
          offset: draft.offset,
          cover: geometry.cover,
        };

  const moved = draft.offset[0] !== 0 || draft.offset[1] !== 0;
  const dirty =
    draft.text !== initial.draft.text || Object.keys(patch).length > 0 || draft.align !== initial.draft.align || moved;

  /* ---------- saving ---------- */

  const latest = useRef({ draft, patch, style, spec, dirty, moved });
  latest.current = { draft, patch, style, spec, dirty, moved };

  const isMine = () => {
    const s = useStore.getState();
    return s.session === docSession && s.editing?.page === page && s.editing.lineId === lineId;
  };

  const close = () => {
    finished.current = true;
    if (isMine()) useStore.getState().stopEditing();
    if (source.kind === "new" && useViewer.getState().draft?.key === lineId) useViewer.setState({ draft: null });
  };

  const send = (spec: PreviewSpec, call: () => Promise<unknown>) => {
    const ghost = addGhost({ kind: "text", page, preview: spec });
    return call().then((result) => {
      if (!result) removeGhost(ghost);
      return result;
    });
  };

  const save = (): Promise<unknown> | null => {
    const { draft, patch, style, spec, dirty, moved } = latest.current;
    const store = useStore.getState();
    const blank = !draft.text.trim();
    if (source.kind === "line") {
      if (!dirty) return null;
      const edit: LineEdit = { lineId: source.line.id, text: draft.text };
      if (Object.keys(patch).length) edit.style = patch;
      if (draft.align !== initial.draft.align) edit.align = draft.align;
      if (moved) edit.offset = draft.offset;
      if (draft.shrink) edit.fit = "shrink";
      return send(spec, () => store.editLine(page, edit));
    }
    const rect = (spec as Extract<PreviewSpec, { kind: "block" }>).rect;
    const placed: Rect = [rect[0] + draft.offset[0], rect[1] + draft.offset[1], rect[2] + draft.offset[0], rect[3] + draft.offset[1]];
    if (source.kind === "new") {
      if (blank) return null;
      store.setToolOptions({ text: style });
      return send(spec, () =>
        store
          .addObject({ kind: "text", page, rect: placed, text: draft.text, style, align: draft.align, lineHeight: LINE_HEIGHT })
          .then((result) => {
            const now = useStore.getState();
            if (result?.createdId && now.tool === "add-text" && !now.editing)
              now.select({ type: "object", page, id: result.createdId });
            return result;
          }),
      );
    }
    if (blank) return store.run("Deleting", () => engine.removeObject(source.object.id));
    if (!dirty) return null;
    return send(spec, () => store.updateObject({ ...source.object, rect: placed, text: draft.text, style, align: draft.align }));
  };

  const commit = (): Promise<unknown> | null => {
    if (finished.current) return null;
    const pending = save();
    close();
    return pending;
  };

  /** Cancel and Done, from a button or a key */
  const dismiss = () => {
    forgetTap();
    close();
  };
  const finish = () => {
    forgetTap();
    commit();
  };

  const remove = () => {
    if (finished.current) return;
    const { spec } = latest.current;
    if (source.kind === "line") {
      send({ ...spec, text: "", offset: [0, 0] }, () => useStore.getState().editLine(page, { lineId: source.line.id, text: "" }));
    } else if (source.kind === "object") {
      void useStore.getState().run("Deleting", () => engine.removeObject(source.object.id));
    }
    close();
  };

  /* ---------- focus and caret ---------- */

  const [caret, setCaret] = useState(initial.draft.text.length);
  const syncCaret = () => field.current && setCaret(field.current.selectionEnd);

  const offsetFor = (u: number) => {
    if (source.kind !== "line") return null;
    const s = latest.current.spec as Extract<PreviewSpec, { kind: "line" }>;
    const b = lineBox(s, REF);
    let x = (u * REF - b.left) / b.scaleX;
    if (source.line.dir === "rtl") x = b.natural - x;
    return offsetAtX(s.text, s.style, s.style.size * REF, x);
  };

  const cancelFocus = useRef(() => {});
  /** iOS: the keyboard is opening and the focus will arrive shortly */
  const focusing = useRef(false);
  const focus = (u?: number) => {
    const el = field.current;
    if (!el) return;
    const wanted = u ?? (editors.caret?.key === id ? editors.caret.u : undefined);
    editors.caret = null;
    const had = document.activeElement === el;
    cancelFocus.current();
    focusing.current = true;
    cancelFocus.current = focusField(
      el,
      () => {
        focusing.current = false;
        const at = wanted === undefined ? null : offsetFor(wanted);
        if (at !== null) el.setSelectionRange(at, at);
        else if (!had) el.setSelectionRange(el.value.length, el.value.length);
        setCaret(el.selectionEnd);
      },
      () => compact && reveal(true),
    );
  };

  const reaches = (x: number, y: number) => {
    const r = box.current?.getBoundingClientRect();
    return !!r && x >= r.left - 32 && x <= r.right + 32 && y >= r.top - 14 && y <= r.bottom + 14;
  };

  const api = useRef<ActiveEditor>({ key: id, commit, cancel: close, focus, reaches });
  Object.assign(api.current, { commit, cancel: close, focus, reaches });

  useLayoutEffect(() => {
    const mine = api.current;
    editors.current = mine;
    return () => {
      if (editors.current === mine) editors.current = null;
    };
  }, []);

  // editing started from outside (no tap handler to focus the field)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!finished.current && !focusing.current && document.activeElement !== field.current) api.current.focus();
    }, 30);
    return () => clearTimeout(timer);
  }, []);

  // closed from outside (tool change, another line): keep the work unless it was undone
  useEffect(
    () => () => {
      const s = useStore.getState();
      if (!isMine()) cancelFocus.current();
      if (finished.current || isMine()) return;
      if (!s.busy && s.session === docSession && s.doc?.pages[page]?.revision === revision) api.current.commit();
      else finished.current = true;
    },
    [],
  );

  // the page changed underneath (undo, recognition): the line id is no longer valid
  useEffect(() => {
    if (finished.current || currentRevision === revision) return;
    if (latest.current.dirty) useStore.getState().toast("The page changed, so the unsaved text was discarded.", "warning");
    close();
  }, [currentRevision]);

  /* ---------- keeping the text in view ---------- */

  /**
   * Scroll just as far as needed for the line being typed to be seen above the keyboard. `opening`: also
   * bring the whole line in sideways when it fits. The desktop view centres the line instead.
   */
  const reveal = (opening: boolean) => {
    const el = scroller.current;
    if (!el || !box.current) return;
    const view = el.getBoundingClientRect();
    const vvTop = window.visualViewport?.offsetTop ?? 0;
    const bar = compact ? dock.current?.getBoundingClientRect() : undefined;
    // a corner card leaves the left of the view free down to the keyboard
    const corner = !!bar && bar.width < view.width * 0.6;
    const dockTop = bar && !corner ? bar.top : view.bottom;
    const right = corner ? bar.left : view.right;
    const whole = box.current.getBoundingClientRect();
    const marker = box.current.parentElement?.querySelector("[data-pv-caret]")?.getBoundingClientRect();
    const target = marker ?? whole;
    const top = Math.max(view.top, vvTop);
    const bottom = Math.max(top + 24, Math.min(view.bottom, dockTop));
    const centre = !compact && opening;
    if (centre || target.top < top + 6 || target.bottom > bottom - 6)
      el.scrollTop += (target.top + target.bottom) / 2 - (top + bottom) / 2;
    const margin = compact ? 12 : 16;
    // a new text box that still fits is kept wholly on screen while it grows
    const growing = compact && source.kind !== "line";
    if ((opening || growing) && whole.width <= right - view.left - margin * 2) {
      if (!compact && (whole.left < view.left + 12 || whole.right > view.right - 12))
        el.scrollLeft += (whole.left + whole.right) / 2 - (view.left + view.right) / 2;
      else if (whole.left < view.left + margin) el.scrollLeft += whole.left - view.left - margin;
      else if (whole.right > right - margin) el.scrollLeft += whole.right - right + margin;
    } else if (marker && compact) {
      // only when the caret leaves the screen, and then only as far as gives it some room again
      if (marker.left < view.left + 8) el.scrollLeft += marker.left - view.left - 48;
      else if (marker.left > right - 16) el.scrollLeft += marker.left - right + 56;
    } else if (marker && (marker.left < view.left + 36 || marker.left > view.right - 36)) {
      el.scrollLeft += marker.left - (view.left + view.width * 0.6);
    }
  };

  const ensureVisible = useRef<(opening: boolean) => void>(() => {});
  const frame = useRef({ id: 0, opening: false });
  ensureVisible.current = (opening) => {
    frame.current.opening ||= opening;
    cancelAnimationFrame(frame.current.id);
    frame.current.id = requestAnimationFrame(() => {
      const el = scroller.current;
      if (!el) return;
      // room to lift the last lines of the document above the keyboard
      if (compact && dock.current) {
        const covered = Math.max(0, el.getBoundingClientRect().bottom - dock.current.getBoundingClientRect().top);
        const inset = Math.round(covered) + 420;
        if (useViewer.getState().bottomInset < inset) useViewer.setState({ bottomInset: inset });
      }
      // the extra scroll room appears with the next React render
      frame.current.id = requestAnimationFrame(() => {
        const first = frame.current.opening;
        frame.current.opening = false;
        reveal(first);
      });
    });
  };

  /** the editor itself changed the zoom: show the line again once it is laid out */
  const zoomed = useRef(false);
  // phones: magnify tiny text so it can be read while typing. The view then stays as it is: no jump back.
  useEffect(() => {
    if (!compact || original.size * scale >= 12) return;
    const next = Math.min(MAX_SCALE, 15 / original.size, scale * 3.5);
    const f = geometry.frame;
    const point: Point =
      source.kind === "line"
        ? fromLocal(f!, [tappedAt ?? f!.uMin, (f!.vMin + f!.vMax) / 2])
        : source.kind === "object"
          ? [source.object.rect[0], source.object.rect[1]]
          : [source.draft.rect[0], source.draft.rect[1]];
    const sheet = box.current?.closest(".pv-page")?.getBoundingClientRect();
    if (!sheet) return;
    const pageHeight = useStore.getState().doc!.pages[page]!.height;
    zoomed.current = true;
    zoomAt(next, page, point, sheet.left + (point[0] / pageWidth) * sheet.width, sheet.top + (point[1] / pageHeight) * sheet.height);
  }, []);

  useEffect(() => () => cancelAnimationFrame(frame.current.id), []);
  const shownOnce = useRef(false);
  useEffect(() => {
    // on phones a pinch by the user is left alone
    if (compact && shownOnce.current && !zoomed.current) return;
    shownOnce.current = true;
    zoomed.current = false;
    ensureVisible.current(true);
  }, [scale, compact]);
  useEffect(() => ensureVisible.current(false), [draft.text, caret, draft.offset, style.size]);

  /* ---------- desktop floating bar ---------- */

  const placeBar = () => {
    const el = bar.current;
    const host = root.current;
    if (!el || !host || !box.current) return;
    const h = host.getBoundingClientRect();
    const b = box.current.getBoundingClientRect();
    const height = el.offsetHeight;
    let top = b.top - h.top - height - 12;
    if (top < 8) top = b.bottom - h.top + 12;
    top = Math.max(8, Math.min(top, h.height - height - 8));
    const left = Math.max(8, Math.min(b.left - h.left, h.width - el.offsetWidth - 20));
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  };
  useLayoutEffect(() => {
    if (!compact) placeBar();
  });
  useEffect(() => {
    const el = scroller.current;
    if (compact || !el) return;
    const onScroll = () => placeBar();
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(onScroll);
    observer.observe(el);
    if (bar.current) observer.observe(bar.current);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [compact]);

  /* ---------- dragging the text ---------- */

  const drag = useRef<{ x: number; y: number; from: Point } | null>(null);
  const handle = {
    onPointerDown(e: ReactPointerEvent) {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, y: e.clientY, from: latest.current.draft.offset };
    },
    onPointerMove(e: ReactPointerEvent) {
      const d = drag.current;
      if (!d) return;
      const offset: Point = [d.from[0] + (e.clientX - d.x) / scale, d.from[1] + (e.clientY - d.y) / scale];
      setDraft((v) => ({ ...v, offset }));
    },
    onPointerUp() {
      drag.current = null;
    },
    onPointerCancel() {
      drag.current = null;
    },
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
  };

  /* ---------- render ---------- */

  const multiline = source.kind !== "line";
  const fieldProps = {
    ref: field,
    value: draft.text,
    rows: 1,
    dir: "auto" as const,
    spellCheck: false,
    autoComplete: "off",
    // new writing gets the keyboard's help; words already in a document are not "corrected" behind the back
    autoCorrect: source.kind === "line" ? "off" : "on",
    autoCapitalize: source.kind === "line" ? "off" : "sentences",
    enterKeyHint: multiline ? ("enter" as const) : ("done" as const),
    "aria-label": source.kind === "line" ? "Edit text" : "Text",
    placeholder: source.kind === "new" ? "Type here" : undefined,
    "data-testid": "line-editor",
    onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
      const raw = e.target.value;
      const text = multiline ? raw : raw.replace(/[\r\n]+/g, " ");
      setDraft((d) => ({ ...d, text }));
      setCaret(e.target.selectionEnd);
    },
    onSelect: syncCaret,
    onKeyUp: syncCaret,
    onKeyDown(e: React.KeyboardEvent) {
      // Enter confirms an input method candidate (CJK, Indic): not ours
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismiss();
      } else if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish();
      }
    },
  };

  // some on-screen keyboards send Enter only as "insert a line break", without a usable key event
  useEffect(() => {
    const el = field.current;
    if (!el || multiline) return;
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType !== "insertLineBreak" && e.inputType !== "insertParagraph") return;
      e.preventDefault();
      api.current.commit();
    };
    el.addEventListener("beforeinput", onBeforeInput);
    return () => el.removeEventListener("beforeinput", onBeforeInput);
  }, [multiline]);

  const controls: StyleBarProps = {
    style,
    align: draft.align,
    defaultFont: source.kind === "new" ? `Default (${original.family})` : `Original (${original.family || "document font"})`,
    onStyle: (p) => {
      setDraft((d) => ({ ...d, patch: { ...d.patch, ...p } }));
      if ("fontChoice" in p) field.current?.focus({ preventScroll: true });
    },
    onAlign: (align) => setDraft((d) => ({ ...d, align })),
    shrink: draft.shrink,
    onShrink: source.kind === "line" ? (shrink) => setDraft((d) => ({ ...d, shrink })) : undefined,
    onNudge: ([x, y]) => setDraft((d) => ({ ...d, offset: [d.offset[0] + x, d.offset[1] + y] })),
    onResetMove: () => setDraft((d) => ({ ...d, offset: [0, 0] })),
    moved,
    onDelete: remove,
    moving,
    onMoving: setMoving,
  };

  // untouched text shows the page itself. Under a finger the caret and the selection must sit on the very
  // letters that are seen, so a stand-in font that runs differently is shown from the start.
  const faithful = source.kind === "line" && Math.abs(geometry.scaleX! - 1) < 0.05;

  return (
    <div className="pv-editor" data-pv-ui="">
      <Preview
        spec={spec}
        scale={scale}
        boxRef={box}
        active
        field={fieldProps}
        ghostText={!dirty && source.kind !== "new" && (!compact || faithful)}
        caret={caret}
        touch={compact}
      >
        {/* on phones the handle would hide the next line: it appears with the move controls */}
        {(!compact || moving) && (
          <button type="button" className="pv-move-handle" aria-label="Drag to move text" title="Drag to move" tabIndex={-1} {...handle}>
            <ArrowsOutCardinalIcon />
          </button>
        )}
      </Preview>
      {compact ? (
        <Dock
          dockRef={dock}
          short={short}
          tiny={tiny}
          onMoved={() => {
            const height = window.visualViewport?.height ?? window.innerHeight;
            // landscape phones with the keyboard up: one row only, or just a corner card
            setShort(height < 330);
            setTiny(height < 130);
            ensureVisible.current(false);
          }}
        >
          <PhoneBar
            {...controls}
            short={short}
            tiny={tiny}
            refocus={() => field.current?.focus({ preventScroll: true })}
            onCancel={dismiss}
            onDone={finish}
          />
        </Dock>
      ) : (
        root.current &&
        createPortal(
          <div ref={bar} className="pv-floating" data-pv-ui="" data-testid="editor-bar">
            <StyleBar {...controls} />
            <div className="pv-floating-actions">
              <button type="button" className="pv-btn" aria-label="Cancel" title="Cancel (Esc)" onMouseDown={(e) => e.preventDefault()} onClick={dismiss} data-testid="editor-cancel">
                <XIcon />
              </button>
              <button type="button" className="pv-btn pv-btn-primary" aria-label="Done" title="Done (Enter)" onMouseDown={(e) => e.preventDefault()} onClick={finish} data-testid="editor-done">
                <CheckIcon weight="bold" />
              </button>
            </div>
          </div>,
          root.current,
        )
      )}
    </div>
  );
}

/** family name of a picked FontChoice, for the preview */
function useChoiceFamily(choice: string | undefined): string | undefined {
  const [found, setFound] = useState<{ id: string; family: string }>();
  useEffect(() => {
    if (!choice) return;
    let live = true;
    engine.listFonts().then(
      (list) => {
        const font = list.find((f) => f.id === choice);
        if (live && font) setFound({ id: choice, family: font.family });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [choice]);
  return choice && found?.id === choice ? found.family : undefined;
}
