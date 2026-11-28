/**
 * Page thumbnails beside the page on wide screens: click to go, Ctrl or Shift to pick several, arrows to
 * move, Delete to remove, drag to reorder, and drop files between two pages to insert them there.
 */
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { engine } from "../../engine/client";
import { useStore } from "../../store";
import { insertImageFiles, insertPdfFile } from "./actions";
import { deletePagesWithUndo, orderAfterMove, Thumb } from "./panels/PagesPanel";
import { range } from "./util";

const MOVING = "application/x-pdfedit-pages";

/** insert dropped files before page `at`, in the order given */
async function insertAt(files: File[], at: number): Promise<void> {
  for (const file of files) {
    const before = useStore.getState().doc!.pageCount;
    if (file.type.startsWith("image/")) await insertImageFiles([file], at);
    else await insertPdfFile(file, at);
    at += useStore.getState().doc!.pageCount - before;
  }
}

export function Sidebar() {
  const count = useStore((s) => s.doc!.pageCount);
  const current = useStore((s) => s.currentPage);
  const session = useStore((s) => s.session);
  const scrollTo = useStore((s) => s.scrollTo);
  const run = useStore((s) => s.run);
  const [picked, setPicked] = useState<number[]>([]);
  const [drop, setDrop] = useState<number | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const anchor = useRef(0);
  const selected = picked.filter((p) => p < count);

  useEffect(() => setPicked([]), [session, count]);

  // keep the page being read in view
  useEffect(() => {
    list.current?.querySelector(`[data-thumb="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const focus = (page: number) => list.current?.querySelector<HTMLElement>(`[data-thumb="${page}"] button`)?.focus();

  const click = (page: number, e: MouseEvent) => {
    if (e.shiftKey) {
      const [a, b] = [Math.min(anchor.current, page), Math.max(anchor.current, page)];
      setPicked(range(b - a + 1).map((i) => i + a));
    } else if (e.ctrlKey || e.metaKey) {
      anchor.current = page;
      setPicked(selected.includes(page) ? selected.filter((p) => p !== page) : [...selected, page]);
    } else {
      anchor.current = page;
      setPicked([]);
      scrollTo(page);
    }
  };

  const key = (e: KeyboardEvent, page: number) => {
    const mod = e.ctrlKey || e.metaKey;
    const to =
      e.key === "ArrowDown" ? page + 1 : e.key === "ArrowUp" ? page - 1 : e.key === "Home" ? 0 : e.key === "End" ? count - 1 : null;
    if (to !== null && !mod) {
      e.preventDefault();
      const next = Math.min(count - 1, Math.max(0, to));
      scrollTo(next);
      requestAnimationFrame(() => focus(next));
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setPicked(range(count));
    } else if (e.key === "Delete" || e.key === "Backspace") {
      // the viewer must not also delete whatever is selected on the page
      e.preventDefault();
      const pages = selected.length ? selected : [page];
      if (pages.length >= count || useStore.getState().busy) return;
      const first = Math.min(...pages);
      void deletePagesWithUndo(pages).then(
        (ok) => ok && requestAnimationFrame(() => focus(Math.min(first, useStore.getState().doc!.pageCount - 1))),
      );
    }
  };

  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(MOVING) || e.dataTransfer.types.includes("Files");
  /** the gap nearest the pointer: before the tile under it, or after */
  const gap = (e: DragEvent): number => {
    const tile = (e.target as Element).closest<HTMLElement>("[data-thumb]");
    if (!tile) return count;
    const box = tile.getBoundingClientRect();
    return Number(tile.dataset.thumb) + (e.clientY > box.top + box.height / 2 ? 1 : 0);
  };

  const dropped = (e: DragEvent) => {
    if (!accepts(e)) return;
    // the window's own drop handler leaves it alone
    e.preventDefault();
    const at = gap(e);
    setDrop(null);
    if (useStore.getState().busy) return;
    const moving = e.dataTransfer.getData(MOVING);
    if (moving) {
      const pages = JSON.parse(moving) as number[];
      const order = orderAfterMove(count, pages, at);
      if (order.some((v, i) => v !== i)) void run("Moving pages", () => engine.reorderPages(order));
    } else {
      const files = Array.from(e.dataTransfer.files);
      if (files.length) void insertAt(files, at);
    }
  };

  return (
    <nav
      className="sh-sidebar"
      aria-label="Page thumbnails"
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes(MOVING) ? "move" : "copy";
        setDrop(gap(e));
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrop(null)}
      onDrop={dropped}
    >
      <ol ref={list}>
        {range(count).map((page) => (
          <li
            key={page}
            data-thumb={page}
            data-drop={drop === page ? "before" : drop === count && page === count - 1 ? "after" : undefined}
          >
            <button
              type="button"
              className="sh-thumb"
              draggable
              tabIndex={page === current ? 0 : -1}
              aria-label={`Go to page ${page + 1}`}
              aria-current={page === current ? "page" : undefined}
              data-picked={selected.includes(page) || undefined}
              onClick={(e) => click(page, e)}
              onKeyDown={(e) => key(e, page)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData(MOVING, JSON.stringify(selected.includes(page) ? selected : [page]));
              }}
              onDragEnd={() => setDrop(null)}
            >
              <Thumb page={page} />
              <span className="sh-thumb-number">{page + 1}</span>
            </button>
          </li>
        ))}
      </ol>
      <p className="sh-sidebar-foot" aria-live="polite">
        {selected.length > 1 ? `${selected.length} selected. Delete removes them.` : ""}
      </p>
    </nav>
  );
}
