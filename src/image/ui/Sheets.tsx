/** Dialogs of the image editor: fonts, export, languages and leaving. */
import { DownloadSimple, ShareNetwork, UploadSimple, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { OCR_LANGUAGES } from "../../ocr";
import { saveBytes, useStore } from "../../store";
import type { FontSample, ImageClient, UploadedFont } from "../client";
import { familiesFor, nearestWeight, scriptOfText } from "../fonts/catalog";
import type { ImageType } from "../metadata";
import { S } from "../strings";
import type { Analysis, LineStyle, Patch } from "../types";
import { EXTENSION, exportPicture } from "./picture";

export function Dialog(props: { title: string; onClose(): void; children: ReactNode; actions?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current!;
    if (!node.open) node.showModal();
    return () => node.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="im-dialog"
      aria-label={props.title}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
      onClick={(e) => e.target === ref.current && props.onClose()}
    >
      <div className="im-dialog-body">
        <header>
          <h2>{props.title}</h2>
          <button type="button" className="im-icon" aria-label={S.close} onClick={props.onClose}>
            <X size={20} aria-hidden />
          </button>
        </header>
        <div className="im-dialog-scroll">{props.children}</div>
        {props.actions && <footer>{props.actions}</footer>}
      </div>
    </dialog>
  );
}

/* ---------- fonts ---------- */

function Sample({ client, font, weight, italic, text }: { client: ImageClient; font: string; weight: number; italic: boolean; text: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [wanted, setWanted] = useState(false);
  const [sample, setSample] = useState<FontSample | null>(null);
  useEffect(() => {
    const node = ref.current!;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setWanted(true), { rootMargin: "80px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!wanted) return;
    let gone = false;
    client.sample({ font, weight, italic }, text, 64).then((s) => !gone && setSample(s), () => {});
    return () => {
      gone = true;
    };
  }, [wanted, client, font, weight, italic, text]);
  useEffect(() => {
    const node = ref.current;
    if (!node || !sample) return;
    node.width = sample.width;
    node.height = sample.height;
    const context = node.getContext("2d")!;
    const image = context.createImageData(sample.width, sample.height);
    const colour = getComputedStyle(node).color.match(/\d+/g)?.map(Number) ?? [0, 0, 0];
    for (let i = 0; i < sample.alpha.length; i++) image.data.set([colour[0]!, colour[1]!, colour[2]!, sample.alpha[i]!], i * 4);
    context.putImageData(image, 0, 0);
  }, [sample]);
  return <canvas ref={ref} className="im-sample" width={200} height={64} aria-hidden />;
}

export function FontSheet(props: {
  client: ImageClient;
  analysis: Analysis;
  style: LineStyle;
  text: string;
  uploaded: UploadedFont[];
  onPick(style: Partial<LineStyle>): void;
  onUpload(file: File): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const text = (props.text || props.analysis.text || "Abc 123").slice(0, 28);
  const families = useMemo(() => familiesFor(scriptOfText(text)), [text]);
  const matching = families.filter((f) => f.name.toLowerCase().includes(query.trim().toLowerCase()));
  const row = (key: string, name: string, weight: number, italic: boolean, detail?: string) => (
    <li key={`${key}:${weight}:${detail}`}>
      <button
        type="button"
        aria-pressed={props.style.font === key && props.style.weight === weight}
        onClick={() => {
          props.onPick({ font: key, weight, italic });
          props.onClose();
        }}
      >
        <span>
          {name}
          {detail && <small>{detail}</small>}
        </span>
        <Sample client={props.client} font={key} weight={weight} italic={italic} text={text} />
      </button>
    </li>
  );
  return (
    <Dialog title={S.chooseFont} onClose={props.onClose}>
      <label className="im-field">
        <span className="im-sr">{S.searchFonts}</span>
        <input type="search" placeholder={S.searchFonts} value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {!query && props.analysis.candidates.length > 0 && (
        <>
          <h3>{S.closest}</h3>
          <ul className="im-fonts">{props.analysis.candidates.slice(0, 6).map((c) => row(c.font, c.family, c.weight, c.italic, `${c.weight}`))}</ul>
        </>
      )}
      <input
        ref={file}
        type="file"
        accept=".ttf,.otf,.ttc"
        hidden
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) props.onUpload(picked);
          e.target.value = "";
        }}
      />
      <button type="button" className="im-btn" onClick={() => file.current?.click()}>
        <UploadSimple size={18} aria-hidden />
        {S.uploadFont}
      </button>
      {props.uploaded.length > 0 && <ul className="im-fonts">{props.uploaded.map((u) => row(u.key, u.family, u.weight, u.italic))}</ul>}
      <h3>{S.allFonts}</h3>
      <ul className="im-fonts">{matching.map((f) => row(f.key, f.name, nearestWeight(f.weights, props.style.weight), props.style.italic && f.italic))}</ul>
    </Dialog>
  );
}

/* ---------- export ---------- */

export function ExportSheet(props: { bitmap: ImageBitmap; patches: Patch[]; fileName: string; sourceType: string; working: boolean; onSaved(): void; onClose(): void }) {
  const [type, setType] = useState<ImageType>(props.sourceType === "image/jpeg" ? "image/jpeg" : props.sourceType === "image/webp" ? "image/webp" : "image/png");
  const [quality, setQuality] = useState(0.94);
  const [name, setName] = useState(() => props.fileName.replace(/\.[^.]+$/, "") + " (edited)");
  const [file, setFile] = useState<File | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const clean = name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "picture";

  // built ahead of the tap: sharing only works straight from one
  useEffect(() => {
    setFile(null);
    setFailed(null);
    if (props.working) return;
    let gone = false;
    const timer = setTimeout(() => {
      exportPicture(props.bitmap, props.patches, type, quality, clean).then(
        (f) => !gone && setFile(f),
        (e) => !gone && setFailed(e instanceof Error ? e.message : String(e)),
      );
    }, 250);
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [props.bitmap, props.patches, props.working, type, quality, clean]);

  const canShare = !!file && !!navigator.canShare?.({ files: [file] });
  const save = async () => {
    if (!file) return;
    saveBytes(new Uint8Array(await file.arrayBuffer()), file.name, file.type);
    props.onSaved();
  };
  const share = () => {
    if (!file) return;
    navigator.share({ files: [file] }).then(props.onSaved, (e: Error) => {
      if (e.name !== "AbortError") useStore.getState().toast(`${S.failed}: ${e.message}`, "error");
    });
  };
  return (
    <Dialog
      title={S.exportTitle}
      onClose={props.onClose}
      actions={
        <>
          {canShare && (
            <button type="button" className="im-btn" onClick={share}>
              <ShareNetwork size={18} aria-hidden />
              {S.share}
            </button>
          )}
          <button type="button" className="im-btn im-primary" disabled={!file} onClick={() => void save()}>
            <DownloadSimple size={18} aria-hidden />
            {file || failed ? S.save : S.preparing}
          </button>
        </>
      }
    >
      <label className="im-field">
        <span>{S.fileName}</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="im-field">
        <span id="im-format">{S.format}</span>
        <div className="im-segmented" role="group" aria-labelledby="im-format">
          {(Object.keys(EXTENSION) as ImageType[]).map((t) => (
            <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)}>
              {t === "image/jpeg" ? "JPEG" : t === "image/png" ? "PNG" : "WebP"}
            </button>
          ))}
        </div>
      </div>
      {type !== "image/png" && (
        <label className="im-slider">
          <span>{S.quality}</span>
          <input type="range" min={0.5} max={1} step={0.01} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
          <output>{Math.round(quality * 100)}%</output>
        </label>
      )}
      <p className="im-note">{S.exportNote(props.bitmap.width, props.bitmap.height)}</p>
      {file && <p className="im-note">{file.size > 1_048_576 ? `${(file.size / 1_048_576).toFixed(1)} MB` : `${Math.ceil(file.size / 1024)} KB`}</p>}
      {failed && (
        <p className="im-error" role="alert">
          {S.exportFailed}: {failed}
        </p>
      )}
    </Dialog>
  );
}

/* ---------- languages ---------- */

export function LanguageSheet(props: { onRead(languages: string[]): void; onClose(): void; changed: boolean }) {
  const chosen = useStore((s) => s.ocr.languages);
  const [picked, setPicked] = useState(chosen);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const list = OCR_LANGUAGES.filter((l) => !q || `${l.name} ${l.nativeName} ${l.script} ${l.code}`.toLowerCase().includes(q));
  return (
    <Dialog
      title={S.languagesTitle}
      onClose={props.onClose}
      actions={
        <button
          type="button"
          className="im-btn im-primary"
          onClick={() => {
            useStore.getState().setOcrLanguages(picked);
            props.onRead(picked);
            props.onClose();
          }}
        >
          {S.readAgain}
        </button>
      }
    >
      {props.changed && <p className="im-note">{S.readAgainWarning}</p>}
      <label className="im-field">
        <span className="im-sr">{S.searchLanguages}</span>
        <input type="search" placeholder={S.searchLanguages} value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <label className="im-toggle">
        <input type="checkbox" checked={!picked.length} onChange={() => setPicked([])} />
        <span>{S.auto}</span>
      </label>
      <ul className="im-languages">
        {list.map((l) => (
          <li key={l.code}>
            <label className="im-toggle">
              <input type="checkbox" checked={picked.includes(l.code)} onChange={(e) => setPicked(e.target.checked ? [...picked, l.code] : picked.filter((c) => c !== l.code))} />
              <span>
                {l.name}
                <small lang="und">{l.nativeName}</small>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
