/**
 * Choosing a font: what the line uses now (with copy and paste of its style), a search, and every font with a
 * live preview of the very text being edited. A full sheet on phones, a dialog on desktops.
 */
import { CaretDownIcon, CheckIcon, CopyIcon, ClipboardTextIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { FontChoice, TextStyle } from "../../../engine/types";
import { useBackClose, useCompact } from "../device";
import { rgbToHex } from "../geometry";
import { useViewer } from "../viewerStore";
import { choiceFont } from "./fontFaces";
import { fontName } from "./fontName";
import { cssFamily } from "./textMetrics";

const RECENT_KEY = "pdfedit.font-recent";

export const GROUPS: [FontChoice["source"], string][] = [
  ["document", "In this document"],
  ["user", "Your fonts"],
  ["builtin", "Standard"],
  ["web", "More fonts"],
];

const CATEGORIES: [FontChoice["category"] | "all", string][] = [
  ["all", "All"],
  ["sans", "Sans"],
  ["serif", "Serif"],
  ["mono", "Mono"],
  ["script", "Handwritten"],
];

const SCRIPT_NAMES = [
  "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala",
  "Arabic", "Hebrew", "Thai", "Lao", "Khmer", "Myanmar", "Tibetan", "Georgian", "Armenian", "Ethiopic", "Hangul",
  "Hiragana", "Katakana", "Han", "Cyrillic", "Greek",
];

/** the writing system a text is mostly in ("Latin" when nothing else) */
export function scriptOf(text: string): string {
  let best = "Latin";
  let count = 0;
  for (const name of SCRIPT_NAMES) {
    const n = text.match(new RegExp(`\\p{Script=${name}}`, "gu"))?.length ?? 0;
    if (n > count) [best, count] = [name, n];
  }
  return best;
}

function readRecent(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function remember(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, 5)));
  } catch {
    /* private mode */
  }
}

/* ---------- loading previews, a few at a time ---------- */

const queue: (() => Promise<unknown>)[] = [];
let running = 0;

function next() {
  while (running < 4 && queue.length) {
    running++;
    void queue.shift()!().finally(() => {
      running--;
      next();
    });
  }
}

const saveData = () => !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;

function Sample({ font, text, root }: { font: FontChoice; text: string; root: HTMLElement | null }) {
  const el = useRef<HTMLSpanElement>(null);
  const [family, setFamily] = useState<string | null>(null);

  useEffect(() => {
    const node = el.current;
    // on a metered connection nothing is downloaded just to be looked at
    if (!node || !root || (font.source === "web" && saveData())) return;
    let live = true;
    let asked = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || asked) return;
        asked = true;
        queue.push(async () => {
          // scrolled past or closed while waiting: not worth a download
          if (!live) return;
          const loaded = await choiceFont(font.id, false, false);
          if (live && loaded) setFamily(loaded.css);
        });
        next();
      },
      { root, rootMargin: "120px 0px" },
    );
    observer.observe(node);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [font.id, font.source, root]);

  const stack = cssFamily({
    family: font.family,
    bold: false,
    italic: false,
    serif: font.category === "serif",
    mono: font.category === "mono",
    css: family ?? undefined,
  });
  return (
    <span ref={el} className="pv-font-sample" style={{ fontFamily: stack }} data-loaded={family ? "" : undefined} aria-hidden="true">
      {text}
    </span>
  );
}

export interface FontContext {
  /** the font list of the document */
  fonts: FontChoice[];
  /** what is being edited, for previews */
  text: string;
  style: TextStyle;
  /** label of the "keep the document's font" entry */
  defaultFont: string;
  /** what the preview is drawn with, in words */
  note?: string;
  onCopyStyle?(): void;
  onPasteStyle?(): void;
}

export function FontPicker({ context, onClose }: { context: FontContext; onClose(picked?: { choice: string | undefined }): void }) {
  const compact = useCompact();
  const { fonts, style } = context;
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number][0]>("all");
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const clip = useViewer((s) => s.styleClip);
  const [copied, setCopied] = useState(false);

  const sample = context.text.trim().slice(0, 32) || "The quick brown fox";
  const script = scriptOf(sample);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (f: FontChoice) =>
      (category === "all" || f.category === category) &&
      // a search finds any font; browsing offers those that can write this text
      (q ? f.family.toLowerCase().includes(q) : f.source === "document" || f.source === "user" || f.scripts.includes(script));
    const found = fonts.filter(match);
    const recent = q || category !== "all" ? [] : readRecent().map((id) => found.find((f) => f.id === id)).filter((f) => !!f);
    return [
      ["Recent", recent as FontChoice[]] as const,
      ...GROUPS.map(([source, label]) => [label, found.filter((f) => f.source === source)] as const),
    ].filter(([, items]) => items.length);
  }, [fonts, query, category, script]);

  const pick = (choice: string | undefined) => {
    if (choice) remember(choice);
    onClose({ choice });
  };

  useBackClose(true, () => onClose());

  // phones: the sheet covers what is visible; the keyboard goes away until the search is tapped
  useEffect(() => {
    if (compact) {
      (document.activeElement as HTMLElement | null)?.blur?.();
      sheet.current?.focus({ preventScroll: true });
    } else search.current?.focus({ preventScroll: true });
  }, [compact]);

  useEffect(() => {
    const el = sheet.current;
    const vv = window.visualViewport;
    if (!el || !compact || !vv) return;
    const place = () => {
      el.style.top = `${vv.offsetTop}px`;
      el.style.height = `${vv.height}px`;
    };
    place();
    vv.addEventListener("resize", place);
    vv.addEventListener("scroll", place);
    return () => {
      vv.removeEventListener("resize", place);
      vv.removeEventListener("scroll", place);
    };
  }, [compact]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      // the dialog keeps the focus
      const items = [...sheet.current!.querySelectorAll<HTMLElement>("button:not([disabled]):not([tabindex='-1']), input")];
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet.current)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const options = [...sheet.current!.querySelectorAll<HTMLElement>("[role=option]")];
    const at = options.indexOf(document.activeElement as HTMLElement);
    const to = at < 0 ? (e.key === "ArrowDown" ? 0 : -1) : at + (e.key === "ArrowDown" ? 1 : -1);
    e.preventDefault();
    if (to < 0) search.current?.focus();
    else options[Math.min(to, options.length - 1)]?.focus();
  };

  const option = (id: string | undefined, label: string, font?: FontChoice, key = id ?? "original") => (
    <button
      key={key}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={(style.fontChoice ?? undefined) === id}
      className="pv-font-option"
      onClick={() => pick(id)}
    >
      <span className="pv-font-name">{label}</span>
      {font && <Sample font={font} text={sample} root={list} />}
      {(style.fontChoice ?? undefined) === id && <CheckIcon className="pv-font-check" weight="bold" />}
    </button>
  );

  return createPortal(
    <div
      className="pv-picker-scrim"
      data-pv-ui=""
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={onKey}
    >
      <div ref={sheet} className="pv-picker" role="dialog" aria-modal="true" aria-label="Choose font" tabIndex={-1} data-testid="font-picker">
        <div className="pv-picker-head">
          <strong>Font</strong>
          <button type="button" className="pv-btn" aria-label="Close fonts" onClick={() => onClose()}>
            <XIcon />
          </button>
        </div>
        <div className="pv-font-details">
          <p>
            <span className="pv-font-swatch" style={{ background: rgbToHex(style.color) }} aria-hidden />
            <span>
              {fontName(style.family)}, {Math.round(style.size * 10) / 10} pt
              {style.bold ? ", bold" : ""}
              {style.italic ? ", italic" : ""}, {rgbToHex(style.color)}
            </span>
          </p>
          {context.note && <p className="pv-font-note">{context.note}</p>}
          {(context.onCopyStyle || context.onPasteStyle) && (
            <div className="pv-font-actions">
              {context.onCopyStyle && (
                <button
                  type="button"
                  className="pv-btn pv-btn-text pv-btn-outline"
                  onClick={() => {
                    context.onCopyStyle!();
                    setCopied(true);
                  }}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Style copied" : "Copy style"}
                </button>
              )}
              {context.onPasteStyle && (
                <button
                  type="button"
                  className="pv-btn pv-btn-text pv-btn-outline"
                  disabled={!clip}
                  onClick={() => {
                    context.onPasteStyle!();
                    onClose();
                  }}
                >
                  <ClipboardTextIcon /> Paste style
                </button>
              )}
            </div>
          )}
        </div>
        <label className="pv-font-search">
          <MagnifyingGlassIcon aria-hidden />
          <input
            ref={search}
            type="search"
            aria-label="Search fonts"
            placeholder="Search fonts"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              const first = sections[0]?.[1][0];
              if (first && query.trim()) pick(first.id);
            }}
          />
        </label>
        <div className="pv-font-chips" role="group" aria-label="Kind of font">
          {CATEGORIES.map(([value, label]) => (
            <button key={value} type="button" className="pv-chip" aria-pressed={category === value} onClick={() => setCategory(value)}>
              {label}
            </button>
          ))}
        </div>
        <div ref={setList} className="pv-font-list" role="listbox" aria-label="Fonts">
          {!query && category === "all" && option(undefined, context.defaultFont)}
          {sections.map(([label, items]) => (
            <div key={label} role="group" aria-label={label}>
              <div className="pv-font-group" aria-hidden="true">
                {label}
              </div>
              {items.map((f) => option(f.id, f.family, f, `${label}:${f.id}`))}
            </div>
          ))}
          {!sections.length && <p className="pv-font-empty">No font matches "{query.trim()}".</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** the button that shows the current font and opens the picker */
export function FontButton({ context, onOpen }: { context: FontContext; onOpen(): void }) {
  const choice = context.style.fontChoice;
  const name = choice ? (context.fonts.find((f) => f.id === choice)?.family ?? "Picked font") : fontName(context.style.family);
  return (
    <button type="button" className="pv-font-button" aria-label="Font" aria-haspopup="dialog" title={`Font: ${name}`} onClick={onOpen}>
      <span>{name}</span>
      <CaretDownIcon aria-hidden />
    </button>
  );
}
