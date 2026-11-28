/** Text recognition for scanned pages: languages, pages, progress. */
import { Scan } from "@phosphor-icons/react";
import { useState } from "react";
import { engine } from "../../../engine/client";
import { OCR_LANGUAGES } from "../../../ocr";
import { useStore } from "../../../store";
import { Button, Check, Progress } from "../controls";
import { describePages } from "../util";
import { PageScope, usePageScope } from "./PageScope";

/** the pages of the latest run, kept so progress survives closing the panel */
let lastRun: number[] = [];

export function OcrPanel() {
  const ocr = useStore((s) => s.ocr);
  const busy = useStore((s) => s.busy !== null);
  const setLanguages = useStore((s) => s.setOcrLanguages);
  const runOcr = useStore((s) => s.runOcr);
  const cancel = useStore((s) => s.cancelOcr);
  const run = useStore((s) => s.run);
  const scope = usePageScope("current");
  const [filter, setFilter] = useState("");

  const needle = filter.trim().toLocaleLowerCase();
  const chosen = new Set(ocr.languages);
  const list = OCR_LANGUAGES.filter(
    (l) => !needle || [l.name, l.nativeName, l.code, l.script].some((v) => v.toLocaleLowerCase().includes(needle)),
  ).sort((a, b) => Number(chosen.has(b.code)) - Number(chosen.has(a.code)) || a.name.localeCompare(b.name));
  const toggle = (code: string, on: boolean) =>
    setLanguages(on ? [...ocr.languages, code] : ocr.languages.filter((c) => c !== code));
  const names = ocr.languages.map((c) => OCR_LANGUAGES.find((l) => l.code === c)?.name ?? c);

  if (ocr.running) {
    const index = Math.max(0, lastRun.indexOf(ocr.progress?.page ?? -1));
    const total = Math.max(1, lastRun.length);
    return (
      <div className="sh-stack sh-pad">
        <p role="status">
          Page {(ocr.progress?.page ?? lastRun[0] ?? 0) + 1}
          {total > 1 ? ` (${index + 1} of ${total})` : ""}
        </p>
        <p className="sh-hint sh-capital">{ocr.progress?.status ?? "Starting"}…</p>
        <Progress value={(index + (ocr.progress?.progress ?? 0)) / total} label="Text recognition progress" />
        <p className="sh-hint">You can close this panel and keep working.</p>
        <Button onClick={cancel} block>
          Stop
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="sh-scroll">
        <div className="sh-stack sh-pad">
          <p className="sh-hint">
            Reads scanned or photographed pages so their text can be searched and edited. It runs on your device;
            language data is downloaded once from a public CDN.
          </p>
          {ocr.done.length > 0 && (
            <div className="sh-stack sh-card">
              <p>Recognised pages {describePages(ocr.done)}. Tap a line on the page to edit it.</p>
              <Button
                disabled={busy}
                onClick={() =>
                  void run("Adding searchable text", () => engine.makeSearchable(ocr.done)).then(
                    (r) => r && useStore.getState().toast("Searchable text added. Download the PDF to keep it.", "success"),
                  )
                }
              >
                Make searchable
              </Button>
            </div>
          )}
          <PageScope scope={scope} />
          <h3>Language</h3>
          <Check
            label="Detect automatically"
            hint="Choosing the language yourself is faster and more accurate."
            checked={!ocr.languages.length}
            onChange={(on) => on && setLanguages([])}
          />
          {names.length > 0 && <p className="sh-status">Selected: {names.join(", ")}</p>}
          {OCR_LANGUAGES.length > 0 && (
            <>
              <input
                className="sh-input"
                type="search"
                name="language-search"
                aria-label="Search languages"
                placeholder="Search languages…"
                autoComplete="off"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <ul className="sh-langs">
                {list.map((l) => (
                  <li key={l.code}>
                    <label className="sh-check">
                      <input type="checkbox" checked={chosen.has(l.code)} onChange={(e) => toggle(l.code, e.target.checked)} />
                      <span>
                        {l.name}
                        <small>
                          <bdi>{l.nativeName}</bdi> · {l.script}
                        </small>
                      </span>
                    </label>
                  </li>
                ))}
                {!list.length && <li className="sh-hint">No language matches “{filter}”.</li>}
              </ul>
            </>
          )}
        </div>
      </div>
      <div className="sh-panel-foot">
        <Button
          variant="primary"
          icon={Scan}
          block
          disabled={busy || !scope.valid || !scope.pages.length}
          onClick={() => {
            lastRun = scope.pages;
            void runOcr(scope.pages);
          }}
        >
          Recognise {scope.pages.length === 1 ? `page ${scope.pages[0]! + 1}` : `${scope.pages.length} pages`}
        </Button>
      </div>
    </>
  );
}
