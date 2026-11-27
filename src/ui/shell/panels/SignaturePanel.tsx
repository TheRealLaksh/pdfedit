/** Make a signature by drawing, typing or uploading a photo, then tap the page to place it. */
import { ArrowUUpLeft, Trash, UploadSimple } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Point, RGB } from "../../../engine/types";
import { useStore } from "../../../store";
import { IMAGE_ACCEPT, pickFiles } from "../actions";
import { Button, Check, Field, IconButton, INK_SWATCHES, Segmented, Swatches } from "../controls";
import { errorText, rgbToHex } from "../util";
import {
  applySignature, drawStrokes, inkFromStrokes, removeBackground, savedSignatures, storeSignatures, trimCanvas,
  type Signature,
} from "./signature";

const INKS = INK_SWATCHES.slice(0, 3);
type Make = (keep: boolean) => void;

function finish(signature: Signature, keep: boolean) {
  if (keep && !storeSignatures([signature, ...savedSignatures()]))
    useStore.getState().toast("The signature could not be saved in this browser. It is still ready to place.", "warning");
  void applySignature(signature);
}

function UseBar({ disabled, onUse }: { disabled: boolean; onUse: Make }) {
  const [keep, setKeep] = useState(false);
  return (
    <>
      <Check label="Remember on this device" hint="Saved in this browser only." checked={keep} onChange={setKeep} />
      <Button variant="primary" block disabled={disabled} onClick={() => onUse(keep)}>
        Use signature
      </Button>
    </>
  );
}

function Draw() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const live = useRef<{ id: number; points: Point[] } | null>(null);
  const [color, setColor] = useState<RGB>(INKS[0]!.value);
  const [pen, setPen] = useState(3);

  const paint = () => {
    const node = canvas.current;
    if (!node) return;
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    const width = Math.round(node.clientWidth * ratio);
    const height = Math.round(node.clientHeight * ratio);
    if (node.width !== width || node.height !== height) {
      node.width = width;
      node.height = height;
    }
    const g = node.getContext("2d")!;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, node.clientWidth, node.clientHeight);
    drawStrokes(g, live.current ? [...strokes, live.current.points] : strokes, color, pen);
  };
  useEffect(paint);
  useEffect(() => {
    const observer = new ResizeObserver(() => paint());
    observer.observe(canvas.current!);
    return () => observer.disconnect();
  });

  const at = (e: PointerEvent): Point => {
    const box = canvas.current!.getBoundingClientRect();
    return [e.clientX - box.left, e.clientY - box.top];
  };
  const down = (e: ReactPointerEvent) => {
    if (live.current || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    live.current = { id: e.pointerId, points: [at(e.nativeEvent)] };
    paint();
  };
  const move = (e: ReactPointerEvent) => {
    if (live.current?.id !== e.pointerId) return;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const point of events.length ? events : [e.nativeEvent]) live.current.points.push(at(point));
    paint();
  };
  const up = (e: ReactPointerEvent) => {
    if (live.current?.id !== e.pointerId) return;
    const points = live.current.points;
    live.current = null;
    setStrokes((s) => [...s, points]);
  };

  return (
    <div className="sh-stack">
      <div className="sh-pad-wrap">
        <canvas
          ref={canvas}
          className="sh-signpad"
          role="img"
          aria-label="Signature drawing area. Draw with a finger or mouse. Use the Type tab instead to sign with the keyboard."
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
        {!strokes.length && <span className="sh-signhint" aria-hidden>Sign here</span>}
      </div>
      <div className="sh-signtools">
        <Swatches hideLabel label="Ink colour" swatches={INKS} value={color} onChange={(c) => c && setColor(c)} />
        <span className="sh-spacer" />
        <IconButton icon={ArrowUUpLeft} label="Undo last stroke" disabled={!strokes.length} onClick={() => setStrokes(strokes.slice(0, -1))} />
        <IconButton icon={Trash} label="Clear drawing" disabled={!strokes.length} onClick={() => setStrokes([])} />
      </div>
      <Segmented
        label="Pen"
        value={pen}
        onChange={setPen}
        options={[
          { value: 2, label: "Fine" },
          { value: 3, label: "Medium" },
          { value: 5, label: "Bold" },
        ]}
      />
      <UseBar
        disabled={!strokes.length}
        onUse={(keep) => {
          const signature = inkFromStrokes(strokes, color, pen);
          if (signature) finish(signature, keep);
        }}
      />
    </div>
  );
}

/* ---------- typed ---------- */

const FONT_BASE = "https://cdn.jsdelivr.net/npm/@fontsource/";
const LATIN = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const LATIN_EXT = "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";
const STYLES = [
  { id: "dancing-script", name: "Flowing" },
  { id: "great-vibes", name: "Formal" },
  { id: "caveat", name: "Casual" },
];
const family = (id: string) => `"sign-${id}", cursive`;

let fontsLoading: Promise<unknown> | null = null;
function loadFonts(): Promise<unknown> {
  fontsLoading ??= Promise.all(
    STYLES.flatMap((style) =>
      [
        ["latin", LATIN],
        ["latin-ext", LATIN_EXT],
      ].map(([subset, unicodeRange]) => {
        const url = `${FONT_BASE}${style.id}@5.3.0/files/${style.id}-${subset}-400-normal.woff2`;
        const face = new FontFace(`sign-${style.id}`, `url(${url})`, { unicodeRange });
        document.fonts.add(face);
        return face.load();
      }),
    ),
  ).catch((e) => {
    fontsLoading = null;
    throw e;
  });
  return fontsLoading;
}

function Typed() {
  const [name, setName] = useState("");
  const [style, setStyle] = useState(STYLES[0]!.id);
  const [color, setColor] = useState<RGB>(INKS[0]!.value);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    loadFonts().catch(() => setOffline(true));
  }, []);

  const make = async (keep: boolean) => {
    await loadFonts().catch(() => {});
    const font = `96px ${family(style)}`;
    const text = name.trim();
    const canvas = document.createElement("canvas");
    let g = canvas.getContext("2d")!;
    g.font = font;
    const m = g.measureText(text);
    const left = Math.max(0, m.actualBoundingBoxLeft);
    canvas.width = Math.min(2400, Math.ceil(left + Math.max(m.width, m.actualBoundingBoxRight) + 40));
    canvas.height = 220;
    g = canvas.getContext("2d")!;
    g.font = font;
    g.fillStyle = rgbToHex(color);
    g.direction = "inherit";
    g.textAlign = "left";
    g.fillText(text, left + 20, 140);
    const trimmed = trimCanvas(canvas);
    if (!trimmed) return;
    finish(
      { type: "image", id: crypto.randomUUID(), url: trimmed.toDataURL("image/png"), width: trimmed.width, height: trimmed.height },
      keep,
    );
  };

  return (
    <div className="sh-stack">
      <Field label="Your name" name="signature-name" autoComplete="name" dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="sh-signstyles" role="radiogroup" aria-label="Style">
        {STYLES.map((s) => (
          <label key={s.id}>
            <input type="radio" name="signature-style" checked={style === s.id} onChange={() => setStyle(s.id)} />
            <span className="sh-sr">{s.name}</span>
            <span className="sh-signsample" style={{ fontFamily: family(s.id), color: rgbToHex(color) }} dir="auto" aria-hidden>
              {name.trim() || "Your name"}
            </span>
          </label>
        ))}
      </div>
      {offline && <p className="sh-hint">The signature fonts could not be downloaded, so a system font is used.</p>}
      <Swatches hideLabel label="Ink colour" swatches={INKS} value={color} onChange={(c) => c && setColor(c)} />
      <UseBar disabled={!name.trim()} onUse={(keep) => void make(keep)} />
    </div>
  );
}

/* ---------- uploaded ---------- */

function Upload() {
  const [source, setSource] = useState<ImageData | null>(null);
  const [remove, setRemove] = useState(true);
  const [strength, setStrength] = useState(0.3);
  const preview = useRef<HTMLCanvasElement>(null);

  const choose = async () => {
    const file = (await pickFiles(IMAGE_ACCEPT))[0];
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const g = canvas.getContext("2d")!;
      g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      setSource(g.getImageData(0, 0, canvas.width, canvas.height));
    } catch (e) {
      useStore.getState().toast("Could not read that image: " + errorText(e), "error");
    }
  };

  useEffect(() => {
    const node = preview.current;
    if (!node || !source) return;
    node.width = source.width;
    node.height = source.height;
    node.getContext("2d")!.putImageData(remove ? removeBackground(source, strength) : source, 0, 0);
  }, [source, remove, strength]);

  const use = (keep: boolean) => {
    const node = preview.current;
    if (!node) return;
    const trimmed = trimCanvas(node);
    if (!trimmed) {
      useStore.getState().toast("Nothing is left of the image. Lower the background strength.", "warning");
      return;
    }
    finish(
      { type: "image", id: crypto.randomUUID(), url: trimmed.toDataURL("image/png"), width: trimmed.width, height: trimmed.height },
      keep,
    );
  };

  return (
    <div className="sh-stack">
      <Button icon={UploadSimple} block onClick={() => void choose()}>
        {source ? "Choose another image" : "Choose an image"}
      </Button>
      {!source && <p className="sh-hint">A photo or scan of your signature on plain paper works best.</p>}
      {source && (
        <>
          <canvas ref={preview} className="sh-signpreview" role="img" aria-label="Signature preview" />
          <Check label="Remove the paper background" checked={remove} onChange={setRemove} />
          {remove && (
            <label className="sh-field">
              <span className="sh-label">Background strength</span>
              <input type="range" min={0} max={1} step={0.02} value={strength} onChange={(e) => setStrength(Number(e.target.value))} />
            </label>
          )}
          <UseBar disabled={false} onUse={use} />
        </>
      )}
    </div>
  );
}

function SavedPreview({ signature }: { signature: Signature }) {
  if (signature.type === "image") return <img src={signature.url} alt="" width={signature.width} height={signature.height} />;
  const { width, height, strokeWidth, color, paths } = signature;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden>
      {paths.map((path, i) => (
        <polyline
          key={i}
          points={path.map((p) => p.join(",")).join(" ")}
          fill="none"
          stroke={rgbToHex(color)}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

type Tab = "draw" | "type" | "upload";

export function SignaturePanel() {
  const [tab, setTab] = useState<Tab>("draw");
  const [saved, setSaved] = useState(savedSignatures);
  const forget = (id: string) => {
    const next = saved.filter((s) => s.id !== id);
    storeSignatures(next);
    setSaved(next);
  };
  return (
    <div className="sh-scroll">
      <div className="sh-stack sh-pad">
        {saved.length > 0 && (
          <div className="sh-field">
            <span className="sh-label">Saved on this device</span>
            <ul className="sh-saved">
              {saved.map((s, i) => (
                <li key={s.id}>
                  <button type="button" aria-label={`Use saved signature ${i + 1}`} onClick={() => void applySignature(s)}>
                    <SavedPreview signature={s} />
                  </button>
                  <IconButton icon={Trash} size={18} label={`Delete saved signature ${i + 1}`} onClick={() => forget(s.id)} />
                </li>
              ))}
            </ul>
          </div>
        )}
        <Segmented
          hideLabel
          label="How to sign"
          value={tab}
          onChange={setTab}
          options={[
            { value: "draw", label: "Draw" },
            { value: "type", label: "Type" },
            { value: "upload", label: "Upload" },
          ]}
        />
        {tab === "draw" ? <Draw /> : tab === "type" ? <Typed /> : <Upload />}
        <p className="sh-hint">This places a picture of your signature. It is not a certificate-based digital signature.</p>
      </div>
    </div>
  );
}
