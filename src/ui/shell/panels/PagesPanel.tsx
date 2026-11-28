/** Page organiser: thumbnails, reorder by drag (or buttons), rotate, delete, duplicate, extract, split, insert. */
import {
  ArrowLeft, ArrowRight, ArrowArcLeft, ArrowArcRight, Copy, DotsSixVertical, Export, Eye, File, FilePdf, FilePlus,
  Images, Scissors, Trash, type Icon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { engine } from "../../../engine/client";
import { saveBytes, useStore } from "../../../store";
import { IMAGE_ACCEPT, insertImageFiles, insertPdfFile, PDF_ACCEPT, pickFiles } from "../actions";
import { Button, Field, Segmented } from "../controls";
import { useDesktop } from "../hooks";
import { baseName, describePages, errorText, parsePageRange, range } from "../util";

/* ---------- thumbnails ---------- */

const cache = new Map<string, ImageData>();
let queue: Promise<unknown> = Promise.resolve();

function renderThumb(key: string, page: number, scale: number, wanted: () => boolean): Promise<ImageData | null> {
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  // one at a time, so thumbnails never starve the page view
  const job = queue.then(async () => {
    if (!wanted()) return null;
    const r = await engine.renderPage(page, scale);
    const image = new ImageData(r.data, r.width, r.height);
    cache.set(key, image);
    if (cache.size > 240) cache.delete(cache.keys().next().value!);
    return image;
  });
  queue = job.catch(() => null);
  return job;
}

export function Thumb({ page }: { page: number }) {
  const info = useStore((s) => s.doc!.pages[page]!);
  const session = useStore((s) => s.session);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = canvas.current!;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), {
      rootMargin: "300px",
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    const target = 150 * Math.min(2, window.devicePixelRatio || 1);
    const scale = target / Math.max(info.width, info.height);
    renderThumb(`${session}:${page}:${info.revision}`, page, scale, () => live)
      .then((image) => {
        const node = canvas.current;
        if (!live || !image || !node) return;
        node.width = image.width;
        node.height = image.height;
        node.getContext("2d")!.putImageData(image, 0, 0);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [visible, session, page, info.revision, info.width, info.height]);

  const wide = info.width > info.height;
  return (
    <span className="sh-thumb-frame">
      <canvas
        ref={canvas}
        width={1}
        height={1}
        style={{ aspectRatio: `${info.width} / ${info.height}`, width: wide ? "100%" : "auto", height: wide ? "auto" : "100%" }}
        aria-hidden
      />
    </span>
  );
}

/* ---------- reordering ---------- */

export async function deletePagesWithUndo(pages: number[]): Promise<boolean> {
  const n = pages.length;
  const result = await useStore.getState().run("Deleting pages", () => engine.deletePages(pages));
  if (!result) return false;
  useStore.getState().toast(`Deleted ${n} ${n === 1 ? "page" : "pages"}`, "success", {
    label: "Undo",
    run: () => void useStore.getState().undo(),
  });
  return true;
}

/** new order after moving `moving` so that it sits before the old index `before` */
export function orderAfterMove(count: number, moving: number[], before: number): number[] {
  const set = new Set(moving);
  const block = [...moving].sort((a, b) => a - b);
  const rest = range(count).filter((i) => !set.has(i));
  const at = rest.filter((i) => i < before).length;
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

interface Drag {
  pointer: number;
  pages: number[];
  x: number;
  y: number;
  active: boolean;
  before: number | null;
}

type Mode = "none" | "split" | "insert";

export function PagesPanel() {
  const count = useStore((s) => s.doc!.pageCount);
  const current = useStore((s) => s.currentPage);
  const busy = useStore((s) => s.busy !== null);
  const run = useStore((s) => s.run);
  const scrollTo = useStore((s) => s.scrollTo);
  const openPanel = useStore((s) => s.openPanel);
  const desktop = useDesktop();
  const [picked, setPicked] = useState<number[]>([]);
  const [mode, setMode] = useState<Mode>("none");
  const [drag, setDrag] = useState<{ x: number; y: number; before: number | null; pages: number[] } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const anchor = useRef<number | null>(null);
  const grid = useRef<HTMLOListElement>(null);

  const selected = picked.filter((p) => p < count).sort((a, b) => a - b);
  const insertAt = selected.length ? selected[selected.length - 1]! + 1 : count;

  const go = (page: number) => {
    scrollTo(page);
    if (!desktop) openPanel(null);
  };

  const toggle = (page: number, extend: boolean) => {
    if (extend && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, page), Math.max(anchor.current, page)];
      setPicked([...new Set([...selected, ...range(b - a + 1).map((i) => i + a)])]);
      return;
    }
    anchor.current = page;
    setPicked(selected.includes(page) ? selected.filter((p) => p !== page) : [...selected, page]);
  };

  const reorder = async (moving: number[], before: number) => {
    const order = orderAfterMove(count, moving, before);
    if (order.every((v, i) => v === i)) return;
    const result = await run("Moving pages", () => engine.reorderPages(order));
    if (result) setPicked(moving.map((p) => order.indexOf(p)));
  };

  const dropTarget = (x: number, y: number): number | null => {
    const tile = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-page]");
    if (!tile || !grid.current?.contains(tile)) return null;
    const box = tile.getBoundingClientRect();
    return Number(tile.dataset.page) + (x > box.left + box.width / 2 ? 1 : 0);
  };

  const pointer = (page: number) => ({
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (busy || e.button !== 0) return;
      const handle = !!(e.target as HTMLElement).closest(".sh-grip");
      // touch drags start on the grip only, so the list can still be scrolled
      if (!handle && e.pointerType !== "mouse") return;
      suppressClick.current = false;
      dragRef.current = {
        pointer: e.pointerId,
        pages: selected.includes(page) ? selected : [page],
        x: e.clientX,
        y: e.clientY,
        active: false,
        before: null,
      };
      // capturing a plain mouse press here would swallow the click that selects the page
      if (handle) e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      const d = dragRef.current;
      if (!d || d.pointer !== e.pointerId) return;
      if (!d.active) {
        if (e.buttons === 0) {
          dragRef.current = null;
          return;
        }
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
        d.active = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      d.before = dropTarget(e.clientX, e.clientY);
      const scroller = grid.current?.closest<HTMLElement>(".sh-scroll");
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        if (e.clientY < box.top + 48) scroller.scrollBy(0, -14);
        else if (e.clientY > box.bottom - 48) scroller.scrollBy(0, 14);
      }
      setDrag({ x: e.clientX, y: e.clientY, before: d.before, pages: d.pages });
    },
    onPointerUp(e: ReactPointerEvent<HTMLElement>) {
      const d = dragRef.current;
      if (!d || d.pointer !== e.pointerId) return;
      dragRef.current = null;
      setDrag(null);
      if (!d.active) return;
      suppressClick.current = true;
      if (d.before !== null) void reorder(d.pages, d.before);
    },
    onPointerCancel() {
      dragRef.current = null;
      setDrag(null);
    },
  });

  const rotate = (degrees: 90 | 270) => void run("Rotating", () => engine.rotatePages(selected, degrees));

  const remove = async () => {
    const first = selected[0]!;
    if (!(await deletePagesWithUndo(selected))) return;
    setPicked([]);
    // the buttons that were just used are gone: carry on from the page that took the first one's place
    requestAnimationFrame(() => {
      const left = useStore.getState().doc!.pageCount;
      grid.current?.querySelector<HTMLElement>(`[data-page="${Math.min(first, left - 1)}"] button`)?.focus();
    });
  };

  const duplicate = async () => {
    // from the end, so earlier indices stay put
    for (const page of [...selected].reverse())
      if (!(await run("Duplicating", () => engine.duplicatePage(page)))) return;
    setPicked(selected.map((p, i) => p + i + 1));
  };

  const extract = async () => {
    const { doc, toast } = useStore.getState();
    useStore.setState({ busy: "Preparing pages" });
    try {
      const bytes = await engine.extractPages(selected);
      saveBytes(bytes, `${baseName(doc!.fileName)} (pages ${describePages(selected)}).pdf`);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      useStore.setState({ busy: null });
    }
  };

  const added = (n: number) => {
    setPicked([]);
    setMode("none");
    useStore.getState().toast(n === 1 ? "Page added" : "Pages added", "success");
  };

  const action = (label: string, Glyph: Icon, onClick: () => void, disabled = false, danger = false) => (
    <button type="button" className={danger ? "sh-action sh-action-danger" : "sh-action"} disabled={disabled || busy} onClick={onClick}>
      <Glyph size={22} aria-hidden />
      {label}
    </button>
  );

  const contiguous = selected.every((p, i) => i === 0 || p === selected[i - 1]! + 1);

  return (
    <>
      <div className="sh-subhead">
        <span aria-live="polite">
          {selected.length ? `${selected.length} of ${count} selected` : `${count} ${count === 1 ? "page" : "pages"}. Tap to select`}
        </span>
        <Button variant="ghost" onClick={() => setPicked(selected.length === count ? [] : range(count))}>
          {selected.length === count ? "Clear" : "Select all"}
        </Button>
      </div>

      <div className="sh-scroll">
        <ol
          className="sh-thumbs"
          ref={grid}
          onKeyDown={(e) => {
            const mod = e.ctrlKey || e.metaKey;
            if (mod && e.key.toLowerCase() === "a") {
              e.preventDefault();
              setPicked(range(count));
            } else if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
              // the viewer must not also delete whatever is selected on the page
              e.preventDefault();
              if (!busy && selected.length && selected.length < count) void remove();
            }
          }}
        >
          {range(count).map((page) => (
            <li
              key={page}
              data-page={page}
              data-dragging={drag?.pages.includes(page) || undefined}
              data-drop={
                drag?.before === page ? "before" : drag?.before === page + 1 && page === count - 1 ? "after" : undefined
              }
              {...pointer(page)}
            >
              <button
                type="button"
                className="sh-thumb"
                aria-pressed={selected.includes(page)}
                aria-current={page === current ? "page" : undefined}
                aria-label={`Page ${page + 1}`}
                onClick={(e) => {
                  if (suppressClick.current) suppressClick.current = false;
                  else toggle(page, e.shiftKey);
                }}
                onDoubleClick={() => go(page)}
              >
                <Thumb page={page} />
                <span className="sh-thumb-number">{page + 1}</span>
              </button>
              <span className="sh-grip" title="Drag to reorder" aria-hidden>
                <DotsSixVertical size={20} weight="bold" />
              </span>
            </li>
          ))}
        </ol>
      </div>

      {drag && (
        <div className="sh-ghost" style={{ transform: `translate(${drag.x + 12}px, ${drag.y + 12}px)` }} aria-hidden>
          {drag.pages.length === 1 ? `Page ${drag.pages[0]! + 1}` : `${drag.pages.length} pages`}
        </div>
      )}

      <div className="sh-panel-foot">
        {mode === "split" && <SplitForm onDone={() => setMode("none")} />}
        {mode === "insert" && (
          <div className="sh-stack">
            <p className="sh-hint">
              {insertAt >= count ? "Added at the end." : `Added after page ${insertAt}.`}
            </p>
            <div className="sh-actionbar">
              {action("PDF", FilePdf, () => {
                void pickFiles(PDF_ACCEPT, true).then(async (files) => {
                  let at = insertAt;
                  let total = 0;
                  for (const file of files) {
                    const before = useStore.getState().doc!.pageCount;
                    if (!(await insertPdfFile(file, at))) break;
                    const n = useStore.getState().doc!.pageCount - before;
                    at += n;
                    total += n;
                  }
                  if (total) added(total);
                });
              })}
              {action("Images", Images, () => {
                void pickFiles(IMAGE_ACCEPT, true).then(async (files) => {
                  if (files.length && (await insertImageFiles(files, insertAt))) added(files.length);
                });
              })}
              {action("Blank", File, () => {
                const page = useStore.getState().doc!.pages[Math.max(0, insertAt - 1)]!;
                void run("Adding page", () => engine.insertBlankPage(insertAt, page.width, page.height)).then(
                  (r) => r && added(1),
                );
              })}
            </div>
          </div>
        )}

        {selected.length > 0 && mode === "none" && (
          <div className="sh-actionbar">
            {action("Turn left", ArrowArcLeft, () => rotate(270))}
            {action("Turn right", ArrowArcRight, () => rotate(90))}
            {action("Earlier", ArrowLeft, () => void reorder(selected, Math.max(0, selected[0]! - 1)), contiguous && selected[0] === 0)}
            {action(
              "Later",
              ArrowRight,
              () => void reorder(selected, Math.min(count, selected[selected.length - 1]! + 2)),
              contiguous && selected[selected.length - 1] === count - 1,
            )}
            {action("Duplicate", Copy, () => void duplicate())}
            {action("Extract", Export, () => void extract())}
            {action("View", Eye, () => go(selected[0]!), selected.length !== 1)}
            {action("Delete", Trash, () => void remove(), selected.length === count, true)}
          </div>
        )}

        <div className="sh-row sh-row-fill">
          <Button icon={FilePlus} aria-expanded={mode === "insert"} onClick={() => setMode(mode === "insert" ? "none" : "insert")}>
            Add pages
          </Button>
          <Button
            icon={Scissors}
            disabled={count < 2}
            aria-expanded={mode === "split"}
            onClick={() => setMode(mode === "split" ? "none" : "split")}
          >
            Split
          </Button>
        </div>
      </div>
    </>
  );
}

function SplitForm({ onDone }: { onDone(): void }) {
  const count = useStore((s) => s.doc!.pageCount);
  const [by, setBy] = useState<"every" | "custom">("every");
  const [every, setEvery] = useState("1");
  const [custom, setCustom] = useState("");

  const size = Number(every);
  const groups: number[][] | null =
    by === "every"
      ? Number.isInteger(size) && size >= 1 && size < count
        ? range(Math.ceil(count / size)).map((i) => range(count).slice(i * size, (i + 1) * size))
        : null
      : (() => {
          const parts = custom.split(";").map((p) => p.trim()).filter(Boolean);
          const parsed = parts.map((p) => parsePageRange(p, count));
          return parts.length && parsed.every(Boolean) ? (parsed as number[][]) : null;
        })();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!groups) return;
    const { doc, toast } = useStore.getState();
    useStore.setState({ busy: "Preparing files" });
    try {
      const files = await engine.splitDocument(groups);
      for (let i = 0; i < files.length; i++) {
        saveBytes(files[i]!, `${baseName(doc!.fileName)} (part ${i + 1}).pdf`);
        // browsers drop downloads that arrive all at once
        if (i < files.length - 1) await new Promise((r) => setTimeout(r, 350));
      }
      toast(`Saved ${files.length} files`, "success");
      onDone();
    } catch (error) {
      toast(errorText(error), "error");
    } finally {
      useStore.setState({ busy: null });
    }
  };

  return (
    <form className="sh-stack" onSubmit={submit}>
      <Segmented
        label="Split into files"
        value={by}
        onChange={setBy}
        options={[
          { value: "every", label: "Equal parts" },
          { value: "custom", label: "Custom" },
        ]}
      />
      {by === "every" ? (
        <Field label="Pages per file" name="split-size" inputMode="numeric" autoComplete="off" value={every} onChange={(e) => setEvery(e.target.value.replace(/\D/g, ""))} />
      ) : (
        <Field
          label="One range per file, separated by ;"
          name="split-ranges"
          autoComplete="off"
          placeholder="e.g. 1-3; 4, 6; 7-9…"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
      )}
      <Button variant="primary" type="submit" disabled={!groups} block>
        {groups ? `Download ${groups.length} ${groups.length === 1 ? "file" : "files"}` : "Download files"}
      </Button>
    </form>
  );
}
