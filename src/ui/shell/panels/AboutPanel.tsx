/** Privacy, honest limits and credits. */
import { GithubLogo } from "@phosphor-icons/react";
import { ThemePicker } from "../controls";
import { useDesktop } from "../hooks";

const LIMITS = [
  "Fonts inside a PDF often contain only the characters already used. New characters may be drawn with the closest free font, and you are told when that happens.",
  "Scanned pages rely on text recognition, which can misread words. Check the result.",
  "Complex layouts, unusual encodings and some scripts may not edit perfectly. Look over the page before sending it.",
  "Any change to a digitally signed PDF invalidates the signature. The export date is recorded as usual.",
  "Very large files depend on your device’s memory.",
  "Whiteout only covers content. Use Redact to remove it for good, and check the downloaded copy.",
  "Dynamic XFA forms are not supported.",
];

const SHORTCUTS = [
  ["Ctrl+O", "Open a file"],
  ["Ctrl+S", "Download"],
  ["Ctrl+F", "Find and replace"],
  ["Ctrl+Z / Ctrl+Y", "Undo / redo"],
  ["Ctrl+Plus / Minus / 0", "Zoom in, out, fit"],
  ["Delete", "Remove the selected item or pages"],
  ["Arrows (+ Shift)", "Move the selected item"],
  ["Esc", "Close or cancel"],
];

export function AboutPanel() {
  const desktop = useDesktop();
  return (
    <div className="sh-scroll">
      <div className="sh-stack sh-pad sh-prose">
        <h3>Your file stays with you</h3>
        <p>
          Opening, editing and saving happen in this browser. The file is not uploaded, there is no account, and the
          app has no analytics.
        </p>
        <p>
          Fonts and text recognition data are downloaded from the jsDelivr public CDN when needed. Those requests show
          which font or language is wanted, never your document. Saved signatures and settings stay in this browser.
        </p>
        <h3>Limits</h3>
        <ul>
          {LIMITS.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {desktop && (
          <>
            <h3>Keyboard</h3>
            <dl className="sh-keys">
              {SHORTCUTS.map(([key, what]) => (
                <div key={key}>
                  <dt>
                    <kbd translate="no">{key}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
        <ThemePicker />
        <h3>Open source</h3>
        <p>
          Free software under the GNU AGPL v3, built on MuPDF, HarfBuzz and Tesseract. Built by{" "}
          <a href="https://lakshpradhwani.com" target="_blank" rel="noreferrer">
            Laksh Pradhwani
          </a>
          .
        </p>
        <a className="sh-btn sh-btn-secondary sh-block" href="https://github.com/TheRealLaksh/pdfedit" target="_blank" rel="noreferrer">
          <GithubLogo size={20} aria-hidden />
          Source code on GitHub
        </a>
      </div>
    </div>
  );
}
