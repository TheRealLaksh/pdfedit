/** Keys and the clipboard while a document is open: scrolling, history, zoom, copy, paste and duplicate. */
import { useEffect, type RefObject } from "react";
import { useStore } from "../../store";
import {
  copyObject, duplicate, focusViewer, hasCopied, pasteCopied, pasteImage, pasteText, selectedObject, viewCentre,
} from "./actions";
import { editors } from "./editor/controller";
import { closeField } from "./layers/FormLayer";
import { peekPageData } from "./pageData";
import { zoomBy } from "./viewerApi";
import { flushInk, showHint, undoInkStroke, useViewer } from "./viewerStore";

/**
 * Undo or redo with a text field open: the draft is saved first, so undo takes back exactly that edit
 * (and redo can bring it back). Returns false when there was nothing to save.
 */
export function saveThen(action: "undo" | "redo"): boolean {
  const saving = editors.current?.commit();
  if (!saving) return false;
  // after a new edit there is nothing left to redo
  if (action === "undo") void saving.then((saved) => saved && useStore.getState().undo());
  return true;
}

/** marks our own copies on the system clipboard */
const OWN = "application/x-pdfedit";

const inField = (target: EventTarget | null) =>
  !!(target as Element | null)?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]");

export function useShortcuts(scroller: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    /** keys that scroll, for when the focus is somewhere that would not scroll by itself */
    const scroll = (e: KeyboardEvent, target: Element): boolean => {
      const el = scroller.current;
      // with the focus inside the scroll area the browser does this natively
      if (!el || el.contains(target)) return false;
      // a panel scrolls itself
      if (target.closest("aside, [role=complementary]")) return false;
      const loose = target === document.body;
      const page = el.clientHeight * 0.85;
      const by = (top: number, left = 0) => {
        el.scrollBy({ top, left });
        el.focus({ preventScroll: true });
        return true;
      };
      if (e.key === "PageDown") return by(page);
      if (e.key === "PageUp") return by(-page);
      if (e.key === "Home") return by(-el.scrollHeight);
      if (e.key === "End") return by(el.scrollHeight);
      if (!loose || useStore.getState().selection) return false;
      if (e.key === " ") return by(e.shiftKey ? -page : page);
      if (e.key === "ArrowDown") return by(60);
      if (e.key === "ArrowUp") return by(-60);
      if (e.key === "ArrowRight") return by(0, 60);
      if (e.key === "ArrowLeft") return by(0, -60);
      return false;
    };

    const onKey = (e: KeyboardEvent) => {
      const store = useStore.getState();
      if (e.defaultPrevented || !store.doc) return;
      const target = e.target as Element;
      const typing = inField(target);
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && (key === "=" || key === "+" || key === "-" || key === "0")) {
        // inside a dialog the browser's own zoom is what is wanted
        if (target.closest?.("[role=dialog]")) return;
        e.preventDefault();
        if (key === "0") store.setZoom("fit");
        else zoomBy(key === "-" ? 1 / 1.2 : 1.2);
        return;
      }
      if (typing) return;
      if (mod && !e.altKey && key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (!undoInkStroke() && !saveThen("undo")) void store.undo();
      } else if (mod && !e.altKey && (key === "y" || (key === "z" && e.shiftKey))) {
        e.preventDefault();
        if (!saveThen("redo")) void store.redo();
      } else if (mod && !e.altKey && key === "a") {
        // selecting "everything" would only paint the buttons blue
        e.preventDefault();
      } else if (mod && !e.altKey && key === "d" && store.selection?.type === "object") {
        e.preventDefault();
        void selectedObject().then((object) => object && duplicate(object));
      } else if ((e.key === "Delete" || e.key === "Backspace") && store.selection && !mod) {
        e.preventDefault();
        focusViewer();
        void store.deleteSelection();
      } else if (e.key === "Escape") {
        // one step back each time, ending at the resting tool
        const viewer = useViewer.getState();
        if (viewer.menu) useViewer.setState({ menu: null });
        else if (viewer.locked) useViewer.setState({ locked: null });
        else if (viewer.field) closeField();
        else if (store.placement) store.setPlacement(null);
        else if (store.selection) store.select(null);
        else if (Object.keys(viewer.redactions).length) useViewer.setState({ redactions: {} });
        else if (store.tool !== "edit-text" && !store.panel) {
          void flushInk();
          store.setTool("edit-text");
        } else return;
        e.preventDefault();
        focusViewer();
      } else if (!mod && !e.altKey && scroll(e, target)) {
        e.preventDefault();
      }
    };

    const onCopy = (e: ClipboardEvent) => {
      const { selection } = useStore.getState();
      // text the user selected with the mouse is copied as usual
      if (inField(e.target) || selection?.type !== "object" || !window.getSelection()?.isCollapsed) return;
      const object = peekPageData("objects", selection.page)?.find((o) => o.id === selection.id);
      if (!object || !e.clipboardData) return;
      e.preventDefault();
      if (!copyObject(object)) return;
      // the clipboard can only be filled during the event
      e.clipboardData.setData(OWN, object.id);
      e.clipboardData.setData("text/plain", object.kind === "text" ? object.text : "");
      if (e.type === "cut") void useStore.getState().deleteSelection();
      else showHint("Copied");
    };

    const onPaste = (e: ClipboardEvent) => {
      const store = useStore.getState();
      if (!store.doc || inField(e.target) || store.editing) return;
      const data = e.clipboardData;
      const spot = viewCentre();
      if (!data || !spot) return;
      const image = [...data.files].find((f) => f.type.startsWith("image/"));
      const text = data.getData("text/plain");
      if (hasCopied() && data.types.includes(OWN)) void pasteCopied(spot.page, null);
      else if (image) void pasteImage(image, spot.page, spot.at);
      else if (text.trim()) void pasteText(text, spot.page, spot.at);
      else if (hasCopied()) void pasteCopied(spot.page, null);
      else return;
      e.preventDefault();
    };

    window.addEventListener("keydown", onKey);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, []);
}
