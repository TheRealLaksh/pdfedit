/** Watermarks and page numbers. */
import { useId, useState, type FormEvent } from "react";
import { engine } from "../../../engine/client";
import type { PageNumberOptions, RGB, TextStyle } from "../../../engine/types";
import { useStore } from "../../../store";
import { Button, Check, Field, INK_SWATCHES, Segmented, Swatches } from "../controls";
import { PageScope, usePageScope } from "./PageScope";

const style = (size: number, color: RGB, bold: boolean): TextStyle => ({
  family: "Noto Sans",
  bold,
  italic: false,
  serif: false,
  mono: false,
  size,
  color,
});

const GREY = { name: "Grey", value: [0.45, 0.45, 0.48] as RGB };
const COLORS = [GREY, ...INK_SWATCHES.slice(0, 4)];

const clampNumber = (text: string, min: number, max: number, fallback: number) => {
  const n = Number(text);
  return text.trim() && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function Select<T extends string | number>(props: {
  label: string;
  value: T;
  options: [NoInfer<T>, string][];
  onChange: (v: NoInfer<T>) => void;
}) {
  const id = useId();
  return (
    <div className="sh-field">
      <label className="sh-label" htmlFor={id}>
        {props.label}
      </label>
      <select
        id={id}
        className="sh-input"
        value={props.value}
        onChange={(e) => props.onChange(props.options[e.target.selectedIndex]![0])}
      >
        {props.options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

const done = (message: string) => useStore.getState().toast(message, "success", {
  label: "Undo",
  run: () => void useStore.getState().undo(),
});

function Watermark() {
  const busy = useStore((s) => s.busy !== null);
  const run = useStore((s) => s.run);
  const scope = usePageScope();
  const [text, setText] = useState("");
  const [size, setSize] = useState("64");
  const [color, setColor] = useState<RGB>(GREY.value);
  const [bold, setBold] = useState(true);
  const [opacity, setOpacity] = useState(0.25);
  const [angle, setAngle] = useState(45);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const result = await run("Adding watermark", () =>
      engine.addWatermark({
        text: text.trim(),
        style: style(clampNumber(size, 6, 400, 64), color, bold),
        opacity,
        angle,
        pages: scope.optional,
      }),
    );
    if (result) done("Watermark added");
  };

  return (
    <form className="sh-stack" onSubmit={submit}>
      <Field label="Watermark text" name="watermark" autoComplete="off" dir="auto" placeholder="e.g. Draft…" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="sh-columns">
        <Field label="Size (pt)" name="watermark-size" inputMode="numeric" autoComplete="off" value={size} onChange={(e) => setSize(e.target.value)} />
        <Select
          label="Opacity"
          value={opacity}
          onChange={setOpacity}
          options={[0.1, 0.25, 0.4, 0.6, 1].map((v) => [v, `${v * 100}%`])}
        />
      </div>
      <Segmented
        label="Direction"
        value={angle}
        onChange={setAngle}
        options={[
          { value: 45, label: "Rising" },
          { value: 0, label: "Level" },
          { value: -45, label: "Falling" },
        ]}
      />
      <Swatches label="Colour" swatches={COLORS} value={color} onChange={(c) => c && setColor(c)} />
      <Check label="Bold" checked={bold} onChange={setBold} />
      <PageScope scope={scope} />
      <Button variant="primary" type="submit" block disabled={busy || !text.trim() || !scope.valid}>
        Add watermark
      </Button>
    </form>
  );
}

const FORMATS: [string, string][] = [
  ["{n}", "1"],
  ["{n} / {total}", "1 / 10"],
  ["Page {n}", "Page 1"],
  ["Page {n} of {total}", "Page 1 of 10"],
  ["custom", "Custom…"],
];

const POSITIONS: [PageNumberOptions["position"], string][] = [
  ["top-left", "Top left"],
  ["top-center", "Top centre"],
  ["top-right", "Top right"],
  ["bottom-left", "Bottom left"],
  ["bottom-center", "Bottom centre"],
  ["bottom-right", "Bottom right"],
];

function Numbers() {
  const busy = useStore((s) => s.busy !== null);
  const run = useStore((s) => s.run);
  const scope = usePageScope();
  const [preset, setPreset] = useState("{n}");
  const [custom, setCustom] = useState("{n} / {total}");
  const [position, setPosition] = useState<PageNumberOptions["position"]>("bottom-center");
  const [size, setSize] = useState("11");
  const [margin, setMargin] = useState("28");
  const [startAt, setStartAt] = useState("1");
  const [color, setColor] = useState<RGB>(INK_SWATCHES[0]!.value);
  const format = preset === "custom" ? custom : preset;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const result = await run("Adding page numbers", () =>
      engine.addPageNumbers({
        format,
        position,
        style: style(clampNumber(size, 4, 96, 11), color, false),
        margin: clampNumber(margin, 0, 200, 28),
        startAt: Math.round(clampNumber(startAt, 0, 1_000_000, 1)),
        pages: scope.optional,
      }),
    );
    if (result) done("Page numbers added");
  };

  return (
    <form className="sh-stack" onSubmit={submit}>
      <Select label="Format" value={preset} onChange={setPreset} options={FORMATS} />
      {preset === "custom" && (
        <Field
          label="Custom format"
          name="number-format"
          autoComplete="off"
          spellCheck={false}
          dir="auto"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          hint="{n} is the page number, {total} the page count."
        />
      )}
      <div className="sh-field">
        <span className="sh-label" id="sh-position">
          Position
        </span>
        <div className="sh-positions" role="group" aria-labelledby="sh-position">
          {POSITIONS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`sh-position sh-position-${value}`}
              aria-pressed={position === value}
              aria-label={label}
              title={label}
              onClick={() => setPosition(value)}
            >
              <span />
            </button>
          ))}
        </div>
      </div>
      <div className="sh-columns sh-columns-3">
        <Field label="Size (pt)" name="number-size" inputMode="numeric" autoComplete="off" value={size} onChange={(e) => setSize(e.target.value)} />
        <Field label="Margin (pt)" name="number-margin" inputMode="numeric" autoComplete="off" value={margin} onChange={(e) => setMargin(e.target.value)} />
        <Field label="Start at" name="number-start" inputMode="numeric" autoComplete="off" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
      </div>
      <Swatches label="Colour" swatches={COLORS} value={color} onChange={(c) => c && setColor(c)} />
      <PageScope scope={scope} />
      <Button variant="primary" type="submit" block disabled={busy || !format.trim() || !scope.valid}>
        Add page numbers
      </Button>
    </form>
  );
}

export function StampPanel() {
  const [tab, setTab] = useState<"watermark" | "numbers">("watermark");
  return (
    <div className="sh-scroll">
      <div className="sh-stack sh-pad">
        <Segmented
          hideLabel
          label="Stamp type"
          value={tab}
          onChange={setTab}
          options={[
            { value: "watermark", label: "Watermark" },
            { value: "numbers", label: "Page numbers" },
          ]}
        />
        {tab === "watermark" ? <Watermark /> : <Numbers />}
      </div>
    </div>
  );
}
