/** Small pure helpers used by the shell. */
import type { RGB } from "../../engine/types";

/**
 * "1-3, 5, 8-" (1-based, inclusive) to zero-based page indices, in the order written, without
 * duplicates. Returns null when the text is not a valid range for `count` pages.
 */
export function parsePageRange(text: string, count: number): number[] | null {
  const out: number[] = [];
  const parts = text.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    const m = /^(\d+)?\s*([-–])?\s*(\d+)?$/.exec(part);
    if (!m || (!m[1] && !m[3])) return null;
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] ? Number(m[3]) : count) : from;
    if (!m[2] && m[1] && m[3]) return null;
    if (from < 1 || to < 1 || from > count || to > count) return null;
    const step = from <= to ? 1 : -1;
    for (let p = from; ; p += step) {
      if (!out.includes(p - 1)) out.push(p - 1);
      if (p === to) break;
    }
  }
  return out;
}

/** zero-based indices to a short 1-based description: [0,1,2,4] -> "1-3, 5" */
export function describePages(pages: number[]): string {
  const sorted = [...pages].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!;
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i]! + 1) i++;
    const end = sorted[i]!;
    parts.push(start === end ? String(start + 1) : `${start + 1}-${end + 1}`);
  }
  return parts.join(", ");
}

export const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

export const baseName = (fileName: string): string => fileName.replace(/\.pdf$/i, "");

export const rgbToHex = (c: RGB): string =>
  "#" + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");

export const hexToRgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export const sameColor = (a: RGB, b: RGB): boolean => a.every((v, i) => Math.abs(v - b[i]!) < 0.01);

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** bytes as people read them; rounded up, so a size shown as within a limit really is */
export function formatSize(bytes: number): string {
  if (bytes < 1000 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  return `${(Math.ceil((bytes / 1024 / 1024) * 10) / 10).toFixed(1)} MB`;
}

/** what the user typed as a safe PDF file name; `fallback` when nothing usable is left */
export function cleanFileName(typed: string, fallback: string): string {
  const base = typed
    .replace(/\.pdf$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 180);
  return base ? `${base}.pdf` : fallback;
}

/** "5 minutes ago" */
export function ago(time: number, now = Date.now()): string {
  const minutes = Math.round((time - now) / 60_000);
  const say = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (minutes > -1) return "just now";
  if (minutes > -60) return say.format(minutes, "minute");
  if (minutes > -60 * 24) return say.format(Math.round(minutes / 60), "hour");
  return say.format(Math.round(minutes / 1440), "day");
}
