/**
 * Filling a form on the page itself: every field is a target. Boxes tick at a tap; writing and choices open
 * a field (docked above the keyboard on phones, on the spot on desktops) with previous and next.
 */
import { CaretDownIcon, CaretUpIcon, CheckIcon, XIcon } from "@phosphor-icons/react";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { engine } from "../../../engine/client";
import type { FormField } from "../../../engine/types";
import { useStore } from "../../../store";
import { ViewerContext } from "../context";
import { useBackClose, useCompact } from "../device";
import { TAP } from "../geometry";
import { Dock } from "../editor/Dock";
import { cancelQueuedTap, editors, holdKeyboard } from "../editor/controller";
import { loadFields, usePageData } from "../pageData";
import { useViewer } from "../viewerStore";

const label = (f: FormField) => f.label || f.name || "Unnamed field";
const fillable = (f: FormField) => !f.readOnly && f.type !== "signature" && f.type !== "button";
const toggles = (f: FormField) => f.type === "checkbox" || f.type === "radio";

/** the open field, so that a tap elsewhere or a tool change keeps what was typed */
export const fieldEditor: { commit: (() => void) | null } = { commit: null };

export function closeField() {
  fieldEditor.commit?.();
  if (useViewer.getState().field) useViewer.setState({ field: null });
}

const set = (field: FormField, value: string | boolean) =>
  void useStore.getState().run("Filling field", () => engine.setFormField(field.page, field.id, value));

const toggle = (field: FormField) => set(field, field.type === "radio" ? true : !field.checked);

/** open a field for writing; from inside the tap, so that a phone shows its keyboard */
function openField(field: FormField) {
  editors.current?.commit();
  cancelQueuedTap();
  closeField();
  holdKeyboard();
  flushSync(() => useViewer.setState({ field, locked: null, menu: null }));
  document.querySelector<HTMLElement>("[data-testid=field-input]")?.focus({ preventScroll: true });
}

/** the field before or after this one: pages in turn, each from the top and along its rows */
async function stepField(from: FormField, direction: 1 | -1) {
  // claimed inside the tap: a phone keeps its keyboard while the list is looked up
  holdKeyboard();
  const all = (await loadFields())
    .filter(fillable)
    .sort((a, b) => a.page - b.page || (Math.abs(a.rect[1] - b.rect[1]) > 6 ? a.rect[1] - b.rect[1] : a.rect[0] - b.rect[0]));
  const next = all[all.findIndex((f) => f.id === from.id && f.page === from.page) + direction];
  closeField();
  if (!next) {
    document.querySelector<HTMLElement>(".pv-scroll")?.focus({ preventScroll: true });
    return;
  }
  if (!document.querySelector(`.pv-page[data-page="${next.page}"]`)) useStore.getState().scrollTo(next.page, next.rect);
  openField(next);
}

export function FormLayer({ page, width, height, scale }: { page: number; width: number; height: number; scale: number }) {
  const compact = useCompact();
  const { last } = usePageData("fields", page, true);
  const open = useViewer((s) => (s.field?.page === page ? s.field : null));
  const fields = last?.filter(fillable);
  if (!fields?.length && !open) return null;
  const box = ([x0, y0, x1, y1]: FormField["rect"]) => ({
    left: `${(x0 / width) * 100}%`,
    top: `${(y0 / height) * 100}%`,
    width: `${((x1 - x0) / width) * 100}%`,
    height: `${((y1 - y0) / height) * 100}%`,
  });
  /** where a field's button lies (CSS px): finger sized on touch screens, with the field itself drawn inside */
  const target = ([x0, y0, x1, y1]: FormField["rect"]) => {
    const w = (x1 - x0) * scale;
    const h = (y1 - y0) * scale;
    const hitW = compact ? Math.max(w, TAP) : w;
    const hitH = compact ? Math.max(h, TAP) : h;
    const x = (hitW - w) / 2;
    const y = (hitH - h) / 2;
    return {
      button: { left: x0 * scale - x, top: y0 * scale - y, width: hitW, height: hitH },
      field: { left: x, top: y, width: w, height: h },
    };
  };
  return (
    <div className="pv-forms" data-testid="form-layer">
      {fields?.map((f) => (
        <button
          key={f.id}
          type="button"
          className={`pv-field${toggles(f) ? " pv-field-toggle" : ""}${open?.id === f.id ? " pv-field-open" : ""}`}
          style={target(f.rect).button}
          role={f.type === "checkbox" ? "checkbox" : f.type === "radio" ? "radio" : undefined}
          aria-checked={toggles(f) ? !!f.checked : undefined}
          aria-label={toggles(f) ? label(f) : `Fill ${label(f)}`}
          title={label(f)}
          data-field={f.name}
          // an open text line keeps the focus until the click decides what happens
          onMouseDown={(e) => useStore.getState().editing && e.preventDefault()}
          onClick={() => {
            if (!toggles(f)) return openField(f);
            editors.current?.commit();
            closeField();
            toggle(f);
          }}
        >
          <span style={target(f.rect).field} />
        </button>
      ))}
      {open && <FieldInput key={open.id} field={open} style={box(open.rect)} />}
    </div>
  );
}

function FieldInput({ field, style }: { field: FormField; style: React.CSSProperties }) {
  const compact = useCompact();
  const { scroller } = useContext(ViewerContext);
  const [draft, setDraft] = useState(field.value);
  const latest = useRef(draft);
  latest.current = draft;
  const saved = useRef(field.value);
  const [session] = useState(() => useStore.getState().session);
  const input = useRef<HTMLElement | null>(null);
  const dock = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);

  const commit = () => {
    // another document by now: its fields are not these
    if (toggles(field) || latest.current === saved.current || useStore.getState().session !== session) return;
    saved.current = latest.current;
    set(field, latest.current);
  };
  const cancel = () => {
    latest.current = saved.current;
    useViewer.setState({ field: null });
    scroller.current?.focus({ preventScroll: true });
  };
  const done = () => {
    closeField();
    if (!compact) scroller.current?.focus({ preventScroll: true });
  };

  useBackClose(true, done);

  const api = useRef(commit);
  api.current = commit;
  useEffect(() => {
    const mine = () => api.current();
    fieldEditor.commit = mine;
    return () => {
      if (fieldEditor.commit === mine) fieldEditor.commit = null;
      // closed from outside (tool change, scrolled far away): keep what was typed
      mine();
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (document.activeElement !== input.current) input.current?.focus({ preventScroll: true });
    }, 30);
    return () => clearTimeout(timer);
  }, []);

  /** the field on the page stays in sight above the docked input */
  const reveal = () => {
    const el = scroller.current;
    const spot = anchor.current?.getBoundingClientRect();
    if (!el || !spot) return;
    const view = el.getBoundingClientRect();
    const bottom = Math.min(view.bottom, dock.current?.getBoundingClientRect().top ?? view.bottom);
    const top = Math.max(view.top, window.visualViewport?.offsetTop ?? 0);
    if (spot.top < top + 8 || spot.bottom > bottom - 8) el.scrollTop += (spot.top + spot.bottom) / 2 - (top + bottom) / 2;
    if (spot.left < view.left + 8 || spot.left > view.right - 40) el.scrollLeft += spot.left - view.left - 24;
  };
  const frame = useRef(0);
  const showField = () => {
    if (dock.current && scroller.current) {
      const covered = Math.max(0, scroller.current.getBoundingClientRect().bottom - dock.current.getBoundingClientRect().top);
      const inset = Math.round(covered) + 200;
      if (useViewer.getState().bottomInset < inset) useViewer.setState({ bottomInset: inset });
    }
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => (frame.current = requestAnimationFrame(reveal)));
  };
  useLayoutEffect(() => {
    showField();
    return () => cancelAnimationFrame(frame.current);
  }, []);

  const keys = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === "Enter" && (!field.multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (compact) void stepField(field, 1);
      else done();
    } else if (e.key === "Tab" && !compact) {
      e.preventDefault();
      void stepField(field, e.shiftKey ? -1 : 1);
    }
  };

  const common = {
    "aria-label": label(field),
    "data-testid": "field-input",
    dir: "auto" as const,
    autoComplete: "off",
    onKeyDown: keys,
    ref: (el: HTMLElement | null) => {
      input.current = el;
    },
  };
  const control = toggles(field) ? (
    <button {...common} type="button" className="pv-btn pv-btn-text pv-btn-outline" onClick={() => toggle(field)}>
      {field.checked ? <CheckIcon weight="bold" /> : null} {field.checked ? "Ticked" : "Tick"}
    </button>
  ) : field.options ? (
    <select
      {...common}
      className="pv-field-input"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        latest.current = e.target.value;
        commit();
      }}
    >
      {!field.options.includes(draft) && <option value={draft}>{draft || "Choose"}</option>}
      {field.options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  ) : field.multiline ? (
    <textarea {...common} className="pv-field-input" rows={compact ? 2 : 3} value={draft} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <input {...common} className="pv-field-input" value={draft} enterKeyHint="next" onChange={(e) => setDraft(e.target.value)} />
  );

  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  const nav = (
    <>
      <button type="button" className="pv-btn" aria-label="Previous field" title="Previous field (Shift+Tab)" onMouseDown={keepFocus} onClick={() => void stepField(field, -1)}>
        <CaretUpIcon />
      </button>
      <button type="button" className="pv-btn" aria-label="Next field" title="Next field (Tab)" onMouseDown={keepFocus} onClick={() => void stepField(field, 1)}>
        <CaretDownIcon />
      </button>
    </>
  );
  const finish = (
    <button type="button" className="pv-btn pv-btn-primary" aria-label="Done" title="Done (Enter)" onMouseDown={keepFocus} onClick={done} data-testid="field-done">
      <CheckIcon weight="bold" />
    </button>
  );

  if (compact)
    return (
      <>
        <div ref={anchor} className="pv-field-anchor" style={style} />
        <Dock dockRef={dock} short={false} onMoved={showField}>
          <div className="pv-fieldbar" data-testid="field-bar">
            <div className="pv-fieldbar-label">{label(field)}</div>
            {control}
            <div className="pv-actions">
              <button type="button" className="pv-btn" aria-label="Cancel" onClick={cancel}>
                <XIcon />
              </button>
              {nav}
              <span className="pv-spacer" />
              {finish}
            </div>
          </div>
        </Dock>
      </>
    );
  return (
    <div ref={anchor} className="pv-field-pop" style={{ left: style.left, top: style.top, minWidth: style.width }} data-pv-ui="" data-testid="field-bar">
      {control}
      <div className="pv-field-pop-actions">
        {nav}
        {finish}
      </div>
    </div>
  );
}
