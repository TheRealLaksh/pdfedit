/** The menu of a right click (or Shift+F10, or a long press on empty paper): what can be done right there. */
import {
  CalendarBlankIcon, CheckIcon, ClipboardTextIcon, CopyIcon, CopySimpleIcon, EyedropperIcon, HighlighterIcon,
  ImageSquareIcon, MagnifyingGlassIcon, PaintBrushIcon, PencilSimpleIcon, TextTIcon, TrashIcon, ArrowClockwiseIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { engine } from "../../engine/client";
import { toEngineImage, useStore } from "../../store";
import { canCopy, copyObject, duplicate, focusViewer, hasCopied, pasteCopied, pasteImage, pasteText, placeMark } from "./actions";
import { useBackClose } from "./device";
import { addTextAt, editLineAt, editTextObject, pastedStyle } from "./editor/controller";
import { FontPicker } from "./editor/FontPicker";
import { fontName } from "./editor/fontName";
import { useFonts } from "./editor/StyleBar";
import { rectCentre } from "./geometry";
import { peekPageData } from "./pageData";
import { showHint, useViewer, type Menu } from "./viewerStore";

interface Item {
  label: string;
  icon: Icon;
  danger?: boolean;
  disabled?: boolean;
  run(): void;
}

const copyText = (text: string) =>
  navigator.clipboard?.writeText(text).then(
    () => showHint("Copied"),
    () => showHint("The browser did not allow copying"),
  );

/** paste whatever the clipboard holds at the spot of the menu */
async function pasteHere(page: number, at: [number, number]) {
  try {
    if (navigator.clipboard?.read) {
      for (const item of await navigator.clipboard.read()) {
        const image = item.types.find((t) => t.startsWith("image/"));
        if (image) return await pasteImage(await item.getType(image), page, at);
      }
    }
    const text = await navigator.clipboard?.readText();
    if (hasCopied() && (!text || text === "​")) return await pasteCopied(page, at);
    if (text) return await pasteText(text, page, at);
    showHint("Nothing to paste");
  } catch {
    if (hasCopied()) await pasteCopied(page, at);
    else showHint("Press Ctrl+V to paste");
  }
}

function replaceImage(page: number, id: string) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = await toEngineImage(file);
      await useStore.getState().run("Replacing image", () => engine.replaceImage(page, id, data));
    } catch (e) {
      useStore.getState().toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  input.click();
}

export function ContextMenu() {
  const menu = useViewer((s) => s.menu);
  const [details, setDetails] = useState<Menu | null>(null);
  return (
    <>
      {menu && <MenuList key={`${menu.x}:${menu.y}`} menu={menu} onDetails={() => setDetails(menu)} />}
      {details?.target.kind === "line" && <LineDetails menu={details} onClose={() => setDetails(null)} />}
    </>
  );
}

/** "identify font": the picker, opened on a line that is not being edited; picking a font restyles the line */
function LineDetails({ menu, onClose }: { menu: Menu; onClose(): void }) {
  const fonts = useFonts();
  if (menu.target.kind !== "line") return null;
  const line = menu.target.line;
  const restyle = (style: Partial<typeof line.style>) =>
    void useStore.getState().editLine(menu.page, { lineId: line.id, text: line.text, style });
  const clip = useViewer.getState().styleClip;
  return (
    <FontPicker
      context={{
        fonts,
        text: line.text,
        style: line.style,
        defaultFont: `Original (${line.style.family ? fontName(line.style.family) : "document font"})`,
        onCopyStyle: () => useViewer.setState({ styleClip: { style: line.style } }),
        onPasteStyle: line.editable && clip ? () => restyle(pastedStyle(clip.style, line.style, fonts)) : undefined,
      }}
      onClose={(picked) => {
        onClose();
        if (picked?.choice && line.editable) restyle({ fontChoice: picked.choice });
        focusViewer();
      }}
    />
  );
}

function itemsFor(menu: Menu, onDetails: () => void): Item[] {
  const { page, at, target } = menu;
  const store = useStore.getState();
  if (target.kind === "line") {
    const { line } = target;
    const clip = useViewer.getState().styleClip;
    return [
      { label: line.editable ? "Edit text" : "Options for this line", icon: PencilSimpleIcon, run: () => editLineAt(page, line, null) },
      { label: "Copy text", icon: CopyIcon, run: () => void copyText(line.text) },
      {
        label: "Highlight",
        icon: HighlighterIcon,
        run: () => void store.addObject({ kind: "highlight", page, rect: line.rect, fill: [1, 0.86, 0.2], opacity: 1 }),
      },
      {
        label: "Find this text",
        icon: MagnifyingGlassIcon,
        run: () => {
          store.setSearch({ query: line.text.trim().slice(0, 120) });
          store.openPanel("find");
        },
      },
      { label: "Font details", icon: EyedropperIcon, run: onDetails },
      { label: "Copy style", icon: PaintBrushIcon, run: () => useViewer.setState({ styleClip: { style: line.style } }) },
      {
        label: "Paste style",
        icon: ClipboardTextIcon,
        disabled: !clip || !line.editable,
        run: () =>
          void engine.listFonts().then((fonts) =>
            useStore.getState().editLine(page, { lineId: line.id, text: line.text, style: pastedStyle(clip!.style, line.style, fonts) }),
          ),
      },
      {
        label: "Delete line",
        icon: TrashIcon,
        danger: true,
        disabled: !line.editable,
        run: () => void store.editLine(page, { lineId: line.id, text: "" }),
      },
    ];
  }
  if (target.kind === "object") {
    const object = peekPageData("objects", page)?.find((o) => o.id === target.id);
    if (!object) return [];
    const items: Item[] = [
      { label: "Duplicate", icon: CopySimpleIcon, disabled: !canCopy(object), run: () => void duplicate(object) },
      { label: "Copy", icon: CopyIcon, disabled: !canCopy(object), run: () => void (copyObject(object) && showHint("Copied")) },
      { label: "Delete", icon: TrashIcon, danger: true, run: () => void useStore.getState().deleteSelection() },
    ];
    if (object.kind === "text") items.unshift({ label: "Edit text", icon: PencilSimpleIcon, run: () => editTextObject(page, object.id) });
    return items;
  }
  if (target.kind === "image")
    return [
      { label: "Replace image", icon: ImageSquareIcon, run: () => replaceImage(page, target.id) },
      { label: "Delete", icon: TrashIcon, danger: true, run: () => void useStore.getState().deleteSelection() },
    ];
  return [
    { label: "Add text here", icon: TextTIcon, run: () => addTextAt(page, at) },
    { label: "Tick here", icon: CheckIcon, run: () => void placeMark(page, at, "tick") },
    { label: "Today's date here", icon: CalendarBlankIcon, run: () => void placeMark(page, at, "date") },
    { label: "Paste", icon: ClipboardTextIcon, run: () => void pasteHere(page, at) },
    {
      label: "Rotate page",
      icon: ArrowClockwiseIcon,
      run: () => void useStore.getState().run("Rotating page", () => engine.rotatePages([page], 90)),
    },
  ];
}

function MenuList({ menu, onDetails }: { menu: Menu; onDetails(): void }) {
  const list = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>({ left: menu.x, top: menu.y });
  const close = (refocus = true) => {
    useViewer.setState({ menu: null });
    if (!refocus) return;
    if (menu.from?.isConnected) menu.from.focus({ preventScroll: true });
    else focusViewer();
  };
  useBackClose(true, () => close());
  const items = itemsFor(menu, onDetails);

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    setPlace({
      left: Math.max(6, Math.min(menu.x, window.innerWidth - el.offsetWidth - 6)),
      top: Math.max(6, Math.min(menu.y, window.innerHeight - el.offsetHeight - 6)),
    });
    el.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const outside = (e: Event) => !list.current?.contains(e.target as Node) && close(false);
    // a scroll or resize leaves the menu pointing at nothing
    const gone = () => close(false);
    const scroller = document.querySelector(".pv-scroll");
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", gone);
    window.addEventListener("blur", gone);
    scroller?.addEventListener("wheel", gone, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", gone);
      window.removeEventListener("blur", gone);
      scroller?.removeEventListener("wheel", gone);
    };
  }, []);

  const onKey = (e: KeyboardEvent) => {
    const all = [...list.current!.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])")];
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => all[(i + all.length) % all.length]?.focus();
    if (e.key === "Escape" || e.key === "Tab") close();
    else if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(-1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  if (!items.length) return null;
  const point = menu.target.kind === "line" ? rectCentre(menu.target.line.rect) : menu.at;
  return createPortal(
    <div
      ref={list}
      className="pv-menu"
      role="menu"
      aria-label={menu.target.kind === "page" ? "Page" : menu.target.kind === "line" ? "Text line" : "Item"}
      data-pv-ui=""
      data-testid="context-menu"
      data-at={point.join(",")}
      style={place}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map(({ label, icon: Glyph, danger, disabled, run }) => (
        <button
          key={label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={disabled}
          className={danger ? "pv-menu-danger" : undefined}
          onClick={() => {
            close(false);
            focusViewer();
            run();
          }}
        >
          <Glyph aria-hidden />
          {label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
