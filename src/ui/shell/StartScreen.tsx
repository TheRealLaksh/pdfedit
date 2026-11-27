/** The first screen: choose or drop a file. */
import { DeviceMobile, FilePdf, FolderOpen, Info, ShieldCheck, TextAa, Translate } from "@phosphor-icons/react";
import { useStore } from "../../store";
import { OPEN_ACCEPT, pickFiles } from "./actions";
import { Button, IconButton, ThemeButton } from "./controls";
import { Logo } from "./Logo";

const POINTS = [
  { icon: TextAa, title: "Edit the words already there", text: "Tap a line and retype it. Font, size and colour are kept wherever the file allows." },
  { icon: Translate, title: "Any language, scans too", text: "Right-to-left and Indic scripts included. Text recognition for scanned pages runs in your browser." },
  { icon: DeviceMobile, title: "Free, no account", text: "Pages, forms, signatures and redaction, on a phone or a computer." },
];

export function StartScreen() {
  const openFiles = useStore((s) => s.openFiles);
  const openPanel = useStore((s) => s.openPanel);
  const busy = useStore((s) => s.busy);
  const choose = async () => {
    const files = await pickFiles(OPEN_ACCEPT, true);
    if (files.length) await openFiles(files);
  };
  return (
    <div className="sh-start">
      <header className="sh-start-head">
        <span className="sh-brand">
          <Logo />
          PDFEdit
        </span>
        <span className="sh-row">
          <ThemeButton />
          <IconButton icon={Info} label="About and privacy" onClick={() => openPanel("about")} />
        </span>
      </header>

      <main className="sh-start-main">
        <h1>Edit the text in any PDF</h1>
        <p className="sh-lead">Tap a line, retype it, download. It keeps its place and its style.</p>

        <div
          className="sh-dropzone"
          // the whole card is a bigger target for pointers; the button inside serves the keyboard
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest("button") && !busy) void choose();
          }}
        >
          <FilePdf size={40} weight="light" aria-hidden />
          <Button variant="primary" icon={FolderOpen} onClick={choose} disabled={!!busy}>
            Choose file
          </Button>
          <p className="sh-hint">
            <span className="sh-fine-only">or drop it here. </span>PDF, or photos to turn into a PDF.
          </p>
        </div>

        <p className="sh-privacy">
          <ShieldCheck size={20} aria-hidden />
          <span>Processed on your device. Your file is never uploaded.</span>
        </p>

        <ul className="sh-points">
          {POINTS.map((p) => (
            <li key={p.title}>
              <p.icon size={22} aria-hidden />
              <div>
                <h2>{p.title}</h2>
                <p>{p.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </main>

      <footer className="sh-start-foot">
        <a href="https://github.com/TheRealLaksh/pdfedit" target="_blank" rel="noreferrer">
          Open source (AGPL)
        </a>
        <a href="https://lakshpradhwani.com" target="_blank" rel="noreferrer">
          Built by Laksh Pradhwani
        </a>
      </footer>
    </div>
  );
}
