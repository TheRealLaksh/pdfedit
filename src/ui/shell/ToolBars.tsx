/** Desktop tool rail, phone bottom bar, the "More" menu and the options of the active tool. */
import {
  ArrowsOutLineHorizontal, DeviceMobile, DotsThree, FolderOpen, Keyboard, MagnifyingGlassMinus,
  MagnifyingGlassPlus, Minus, Plus, TextB, TextItalic, X, type Icon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RGB } from "../../engine/types";
import { useStore, type PanelId, type ToolId } from "../../store";
import { chooseTool, closeDocument, openAnother } from "./actions";
import { Button, IconButton, INK_SWATCHES, MARKER_SWATCHES, Segmented, Swatches, ThemePicker } from "./controls";
import { useDialog } from "./hooks";
import { InstallItem } from "./Install";
import { useSwipeToClose } from "./swipe";
import { INSTALL, KEYS } from "./strings";
import { MORE_GROUPS, PANELS, RAIL, TOOLS } from "./tools";
import { togglePanel, useZoom } from "./TopBar";
import { useShell } from "./uiStore";
import { rgbToHex, sameColor } from "./util";

export function ToolRail() {
  const tool = useStore((s) => s.tool);
  const letters = useShell((s) => s.letterKeys);
  return (
    <nav className="sh-rail" aria-label="Tools">
      {RAIL.map((id, i) =>
        id === null ? (
          <hr key={i} />
        ) : (
          <IconButton
            key={id}
            data-tool-button={id}
            icon={TOOLS[id].icon}
            label={TOOLS[id].label}
            hint={letters ? TOOLS[id].key : undefined}
            aria-keyshortcuts={letters ? TOOLS[id].key : undefined}
            pressed={tool === id}
            onClick={() => chooseTool(id)}
          />
        ),
      )}
    </nav>
  );
}

function BarButton(props: { icon: Icon; label: string; tool?: ToolId; pressed?: boolean; expanded?: boolean; onClick(): void }) {
  return (
    <button type="button" data-tool-button={props.tool} aria-pressed={props.pressed} aria-expanded={props.expanded} onClick={props.onClick}>
      <span>
        <props.icon size={24} weight={props.pressed ? "fill" : "regular"} aria-hidden />
      </span>
      {props.label}
    </button>
  );
}

export function BottomBar() {
  const tool = useStore((s) => s.tool);
  const panel = useStore((s) => s.panel);
  const menuOpen = useShell((s) => s.menuOpen);
  const setMenu = useShell((s) => s.setMenu);
  const bar = (id: "edit-text" | "add-text") => (
    <BarButton tool={id} icon={TOOLS[id].icon} label={TOOLS[id].label} pressed={tool === id && !panel} onClick={() => chooseTool(id)} />
  );
  return (
    <nav className="sh-bottom" aria-label="Tools">
      {bar("edit-text")}
      {bar("add-text")}
      <BarButton icon={TOOLS.signature.icon} label="Sign" pressed={panel === "signature" || tool === "signature"} onClick={() => togglePanel("signature")} />
      <BarButton icon={PANELS.pages.icon} label="Pages" pressed={panel === "pages"} onClick={() => togglePanel("pages")} />
      <BarButton icon={DotsThree} label="More" expanded={menuOpen} onClick={() => setMenu(!menuOpen)} />
    </nav>
  );
}

const DOCUMENT_PANELS: PanelId[] = ["find", "forms", "ocr", "stamp", "fonts", "export"];

export function MoreMenu({ desktop }: { desktop: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const tool = useStore((s) => s.tool);
  const hasForms = useStore((s) => s.doc?.hasForms);
  const setMenu = useShell((s) => s.setMenu);
  const setKeysOpen = useShell((s) => s.setKeysOpen);
  const zoom = useZoom();
  const close = () => setMenu(false);
  useDialog(ref, { modal: true, onClose: close });
  const swipe = useSwipeToClose(ref, close, !desktop);

  const item = (key: string, Glyph: Icon, label: string, run: () => void, note?: string) => (
    <li key={key}>
      <button type="button" className="sh-item" onClick={run}>
        <Glyph size={22} aria-hidden />
        <span>{label}</span>
        {note && <small>{note}</small>}
      </button>
    </li>
  );
  const panelItem = (id: PanelId) =>
    item(id, PANELS[id].icon, id === "export" ? "Download options" : PANELS[id].title, () => togglePanel(id),
      id === "forms" && hasForms ? "This PDF has a form" : undefined);
  const zoomButton = (Glyph: Icon, label: string, run: () => void, disabled = false) => (
    <button
      type="button"
      className="sh-action"
      disabled={disabled}
      onClick={() => {
        close();
        run();
      }}
    >
      <Glyph size={22} aria-hidden />
      {label}
    </button>
  );

  return (
    <div className={desktop ? "sh-modal sh-popover" : "sh-modal"}>
      <div className="sh-scrim" onClick={close} />
      <div ref={ref} className={desktop ? "sh-menu" : "sh-sheet sh-more"} role="dialog" aria-modal="true" aria-label="More" tabIndex={-1}>
        {!desktop && (
          <div className="sh-panel-head" data-swipe {...swipe}>
            <h2>More</h2>
            <IconButton icon={X} label="Close" onClick={close} />
          </div>
        )}
        <div className="sh-scroll">
          {!desktop &&
            MORE_GROUPS.map((group) => (
              <section key={group.title} className="sh-group-tools">
                <h3 id={`sh-more-${group.tools[0]}`}>{group.title}</h3>
                <ul className="sh-toolgrid" aria-labelledby={`sh-more-${group.tools[0]}`}>
                  {group.tools.map((id) => {
                    const meta = TOOLS[id];
                    return (
                      <li key={id}>
                        <button type="button" aria-pressed={tool === id} onClick={() => chooseTool(id)}>
                          <meta.icon size={24} weight={tool === id ? "fill" : "regular"} aria-hidden />
                          {meta.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          {!desktop && <h3 className="sh-more-head">Document</h3>}
          <ul className="sh-list">
            {DOCUMENT_PANELS.filter((p) => !desktop || (p !== "find" && p !== "export")).map(panelItem)}
          </ul>
          <hr />
          {!desktop && (
            <>
              <div className="sh-zoomrow">
                {zoomButton(MagnifyingGlassMinus, "Zoom out", zoom.zoomOut)}
                {zoomButton(MagnifyingGlassPlus, "Zoom in", zoom.zoomIn)}
                {zoomButton(ArrowsOutLineHorizontal, "Fit to width", zoom.toggleFit, zoom.zoom === "fit")}
              </div>
              <hr />
            </>
          )}
          <ul className="sh-list">
            {item("open", FolderOpen, "Open another file", () => { close(); void openAnother(); })}
            {item("close", X, "Close document", () => void closeDocument())}
            {desktop && item("keys", Keyboard, KEYS.open, () => setKeysOpen(true), "?")}
            <InstallItem render={(run) => item("install", DeviceMobile, INSTALL.action, run)} />
            {panelItem("about")}
          </ul>
          <hr />
          <div className="sh-pad">
            <ThemePicker />
          </div>
        </div>
      </div>
    </div>
  );
}

const WIDTHS = [1, 2, 4, 8];
const OPACITIES = [1, 0.75, 0.5, 0.25];
type Tray = "colour" | "fill" | "width" | "opacity";

const nameOf = (value: RGB | null, list = INK_SWATCHES) =>
  value === null ? "none" : (list.find((s) => sameColor(s.value, value))?.name ?? "custom");

/** give the focus back to the button of a tool, so the keyboard is not sent to the top of the page */
function focusTool(tool: ToolId): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-tool-button="${tool}"]`)?.focus({ preventScroll: true }));
}

/**
 * One slim row for the active tool: each setting is a button that shows its value and opens its choices in a
 * tray above the row.
 */
export function ToolOptions() {
  const tool = useStore((s) => s.tool);
  const options = useStore((s) => s.toolOptions);
  const set = useStore((s) => s.setToolOptions);
  const setTool = useStore((s) => s.setTool);
  const [tray, setTray] = useState<Tray | null>(null);
  useEffect(() => setTray(null), [tool]);
  // editing text is the resting state; the viewer has its own bar while a line is open
  if (tool === "edit-text") return null;
  const meta = TOOLS[tool];
  const shape = tool === "rect" || tool === "ellipse";
  const stroked = shape || tool === "line" || tool === "arrow" || tool === "ink";
  const adding = tool === "add-text";
  const coloured = stroked || tool === "highlight" || adding;
  const palette = tool === "highlight" ? MARKER_SWATCHES : INK_SWATCHES;
  const colourLabel = adding ? "Text colour" : tool === "highlight" ? "Highlight colour" : "Line colour";
  const colour = adding ? options.text.color : options.color;
  const text = options.text;
  const setText = (patch: Partial<typeof text>) => set({ text: { ...text, ...patch } });
  const size = (value: number) => setText({ size: Math.min(144, Math.max(4, Math.round(value))) });

  const chip = (id: Tray, label: string, face: ReactNode) => (
    <button
      type="button"
      className="sh-optchip"
      aria-label={label}
      title={label}
      aria-expanded={tray === id}
      onClick={() => setTray(tray === id ? null : id)}
    >
      {face}
    </button>
  );
  const dot = (value: RGB | null) => (
    <span className="sh-dot" data-none={value === null || undefined} style={{ background: value ? rgbToHex(value) : undefined }} />
  );

  return (
    <section
      className="sh-options"
      aria-label={`${meta.label} options`}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (tray) setTray(null);
        else {
          setTool("edit-text");
          focusTool("edit-text");
        }
      }}
    >
      <p className="sh-options-hint">
        <strong>{meta.label}</strong>
        <span>{meta.hint}</span>
      </p>
      {tray && (
        <div className="sh-options-tray">
          {tray === "colour" && (
            <Swatches
              hideLabel
              label={colourLabel}
              swatches={palette}
              value={colour}
              onChange={(c) => {
                if (!c) return;
                if (adding) setText({ color: c });
                else set({ color: c });
              }}
            />
          )}
          {tray === "fill" && <Swatches hideLabel label="Fill" allowNone value={options.fill} onChange={(fill) => set({ fill })} />}
          {tray === "width" && (
            <Segmented
              hideLabel
              label="Line width"
              value={options.strokeWidth}
              onChange={(strokeWidth) => set({ strokeWidth })}
              options={WIDTHS.map((w) => ({
                value: w,
                title: `${w} pt`,
                label: <span className="sh-width" style={{ height: Math.max(1.5, w) }} />,
              }))}
            />
          )}
          {tray === "opacity" && (
            <Segmented
              hideLabel
              label="Opacity"
              value={options.opacity}
              onChange={(opacity) => set({ opacity })}
              options={OPACITIES.map((o) => ({ value: o, label: `${o * 100}%` }))}
            />
          )}
        </div>
      )}
      <div className="sh-options-row">
        {adding && (
          <>
            <div className="sh-stepper" role="group" aria-label="Text size">
              <IconButton icon={Minus} size={18} label="Smaller text" onClick={() => size(text.size - 1)} />
              <output aria-live="polite">{text.size} pt</output>
              <IconButton icon={Plus} size={18} label="Larger text" onClick={() => size(text.size + 1)} />
            </div>
            <IconButton icon={TextB} label="Bold" pressed={text.bold} onClick={() => setText({ bold: !text.bold })} />
            <IconButton icon={TextItalic} label="Italic" pressed={text.italic} onClick={() => setText({ italic: !text.italic })} />
          </>
        )}
        {coloured && chip("colour", `Choose ${colourLabel.toLowerCase()}, now ${nameOf(colour, palette)}`, dot(colour))}
        {stroked &&
          chip("width", `Choose line width, now ${options.strokeWidth} pt`, <span className="sh-width" style={{ height: Math.max(1.5, options.strokeWidth) }} />)}
        {shape && chip("fill", `Choose fill, now ${nameOf(options.fill)}`, <>{dot(options.fill)}<small>Fill</small></>)}
        {(stroked || tool === "highlight") && chip("opacity", `Choose opacity, now ${options.opacity * 100}%`, <small>{options.opacity * 100}%</small>)}
        <Button
          variant="ghost"
          className="sh-options-done"
          onClick={() => {
            setTool("edit-text");
            focusTool("edit-text");
          }}
        >
          Done
        </Button>
      </div>
    </section>
  );
}
