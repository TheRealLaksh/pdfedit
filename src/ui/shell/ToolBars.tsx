/** Desktop tool rail, phone bottom bar, the "More" menu and the options of the active tool. */
import { DotsThree, FolderOpen, MagnifyingGlassMinus, MagnifyingGlassPlus, ArrowsOutLineHorizontal, TextB, TextItalic, Minus, Plus, X, type Icon } from "@phosphor-icons/react";
import { useRef } from "react";
import { useStore, type PanelId } from "../../store";
import { chooseTool, closeDocument, openAnother } from "./actions";
import { Button, IconButton, MARKER_SWATCHES, Segmented, Swatches, ThemePicker } from "./controls";
import { useDialog } from "./hooks";
import { MORE_TOOLS, PANELS, RAIL, TOOLS } from "./tools";
import { togglePanel, useZoom } from "./TopBar";
import { useShell } from "./uiStore";

export function ToolRail() {
  const tool = useStore((s) => s.tool);
  return (
    <nav className="sh-rail" aria-label="Tools">
      {RAIL.map((id, i) =>
        id === null ? (
          <hr key={i} />
        ) : (
          <IconButton
            key={id}
            icon={TOOLS[id].icon}
            label={TOOLS[id].label}
            pressed={tool === id}
            onClick={() => chooseTool(id)}
          />
        ),
      )}
    </nav>
  );
}

function BarButton(props: { icon: Icon; label: string; pressed?: boolean; expanded?: boolean; onClick(): void }) {
  return (
    <button type="button" aria-pressed={props.pressed} aria-expanded={props.expanded} onClick={props.onClick}>
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
    <BarButton icon={TOOLS[id].icon} label={TOOLS[id].label} pressed={tool === id && !panel} onClick={() => chooseTool(id)} />
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
  const zoom = useZoom();
  useDialog(ref, { modal: true, onClose: () => setMenu(false) });

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

  return (
    <div className={desktop ? "sh-modal sh-popover" : "sh-modal"}>
      <div className="sh-scrim" onClick={() => setMenu(false)} />
      <div ref={ref} className={desktop ? "sh-menu" : "sh-sheet sh-more"} role="dialog" aria-modal="true" aria-label="More" tabIndex={-1}>
        {!desktop && (
          <div className="sh-panel-head">
            <h2>More</h2>
            <IconButton icon={X} label="Close" onClick={() => setMenu(false)} />
          </div>
        )}
        <div className="sh-scroll">
          {!desktop && (
            <ul className="sh-toolgrid" aria-label="Tools">
              {MORE_TOOLS.map((id) => {
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
          )}
          <ul className="sh-list">{DOCUMENT_PANELS.filter((p) => !desktop || p !== "find").map(panelItem)}</ul>
          <hr />
          <ul className="sh-list">
            {!desktop && item("in", MagnifyingGlassPlus, "Zoom in", () => { setMenu(false); zoom.zoomIn(); })}
            {!desktop && item("out", MagnifyingGlassMinus, "Zoom out", () => { setMenu(false); zoom.zoomOut(); })}
            {!desktop && zoom.zoom !== "fit" && item("fit", ArrowsOutLineHorizontal, "Fit to width", () => { setMenu(false); zoom.toggleFit(); })}
            {item("open", FolderOpen, "Open another file", () => { setMenu(false); void openAnother(); })}
            {item("close", X, "Close document", () => void closeDocument())}
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

export function ToolOptions() {
  const tool = useStore((s) => s.tool);
  const options = useStore((s) => s.toolOptions);
  const set = useStore((s) => s.setToolOptions);
  const setTool = useStore((s) => s.setTool);
  // editing text is the resting state; the viewer has its own bar while a line is open
  if (tool === "edit-text") return null;
  const meta = TOOLS[tool];
  const shape = tool === "rect" || tool === "ellipse";
  const stroked = shape || tool === "line" || tool === "arrow" || tool === "ink";
  const text = options.text;
  const setText = (patch: Partial<typeof text>) => set({ text: { ...text, ...patch } });
  const size = (value: number) => setText({ size: Math.min(144, Math.max(4, Math.round(value))) });

  return (
    <section className="sh-options" aria-label={`${meta.label} options`}>
      <div className="sh-options-head">
        <p>
          <strong>{meta.label}</strong>
          <span>{meta.hint}</span>
        </p>
        <Button variant="ghost" onClick={() => setTool("edit-text")}>
          Done
        </Button>
      </div>
      {(stroked || tool === "highlight" || tool === "add-text") && (
        <div className="sh-options-row">
          {tool === "add-text" ? (
            <>
              <div className="sh-stepper" role="group" aria-label="Text size">
                <IconButton icon={Minus} size={18} label="Smaller text" onClick={() => size(text.size - 1)} />
                <output aria-live="polite">{text.size} pt</output>
                <IconButton icon={Plus} size={18} label="Larger text" onClick={() => size(text.size + 1)} />
              </div>
              <IconButton icon={TextB} label="Bold" pressed={text.bold} onClick={() => setText({ bold: !text.bold })} />
              <IconButton icon={TextItalic} label="Italic" pressed={text.italic} onClick={() => setText({ italic: !text.italic })} />
              <Swatches hideLabel label="Text colour" value={text.color} onChange={(c) => c && setText({ color: c })} />
            </>
          ) : (
            <>
              <Swatches
                hideLabel
                label={tool === "highlight" ? "Highlight colour" : "Line colour"}
                swatches={tool === "highlight" ? MARKER_SWATCHES : undefined}
                value={options.color}
                onChange={(c) => c && set({ color: c })}
              />
              {stroked && (
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
              {shape && (
                <div className="sh-inline">
                  <span aria-hidden>Fill</span>
                  <Swatches hideLabel label="Fill" allowNone value={options.fill} onChange={(fill) => set({ fill })} />
                </div>
              )}
              <label className="sh-inline">
                <span>Opacity</span>
                <select className="sh-input" name="opacity" value={options.opacity} onChange={(e) => set({ opacity: Number(e.target.value) })}>
                  {OPACITIES.map((o) => (
                    <option key={o} value={o}>
                      {o * 100}%
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>
      )}
    </section>
  );
}
