/** The first screen: choose or drop a file. The copy below the fold also says what the app does to a search engine. */
import { DeviceMobile, FileText, FolderOpen, Info, ShieldCheck, WarningCircle, X } from "@phosphor-icons/react";
import { useState } from "react";
import { useStore } from "../../store";
import { OPEN_ACCEPT, openSample, pickFiles } from "./actions";
import { useBoot } from "./boot";
import { Button, IconButton, Progress, ThemeButton } from "./controls";
import { DraftCard } from "./Drafts";
import { useInstall } from "./Install";
import { Logo } from "./Logo";
import { INSTALL, START } from "./strings";
import { remember, remembered } from "./uiStore";

/** offered once there is a reason to come back: after a first finished file */
function InstallOffer() {
  const install = useInstall();
  const [hidden, setHidden] = useState(() => !remembered("finished-once", false) || remembered("install-dismissed", false));
  if (!install || hidden) return null;
  return (
    <aside className="sh-offer">
      <DeviceMobile size={22} aria-hidden />
      <p>{INSTALL.offer}</p>
      <Button onClick={install}>{INSTALL.action}</Button>
      <IconButton
        icon={X}
        size={18}
        label={INSTALL.later}
        onClick={() => {
          remember("install-dismissed", true);
          setHidden(true);
        }}
      />
    </aside>
  );
}

/** shown only while the first download is on its way: a file can be chosen all the same */
function EngineProgress() {
  const percent = useBoot((s) => (s.ready ? null : s.percent));
  const busy = useStore((s) => s.busy !== null);
  if (percent === null || busy) return null;
  return (
    <div className="sh-boot">
      <span>Getting the editor ready, {percent}%</span>
      <Progress value={percent / 100} label="Editor download" />
    </div>
  );
}

export function StartScreen() {
  const openFiles = useStore((s) => s.openFiles);
  const openPanel = useStore((s) => s.openPanel);
  const busy = useStore((s) => s.busy);
  const error = useStore((s) => s.openError);
  const install = useInstall();
  const choose = async () => {
    const files = await pickFiles(OPEN_ACCEPT, true);
    if (files.length) await openFiles(files);
  };
  return (
    <div className="sh-start">
      <header className="sh-start-head">
        <span className="sh-brand">
          <Logo />
          {START.name}
        </span>
        <span className="sh-row">
          <ThemeButton />
          <IconButton icon={Info} label="About and privacy" onClick={() => openPanel("about")} />
        </span>
      </header>

      <main className="sh-start-main">
        <DraftCard />
        {error && (
          <div className="sh-openerror" role="alert">
            <WarningCircle size={22} weight="fill" aria-hidden />
            <p className="sh-break">{error}</p>
            <Button onClick={choose} disabled={!!busy}>
              Choose another file
            </Button>
          </div>
        )}

        {/* the page is the product: a sheet of paper whose headline is being edited */}
        <section
          className="sh-sheetcard"
          // the whole sheet is a bigger target for pointers; the buttons inside serve the keyboard
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest("button") && !busy && !window.getSelection()?.toString()) void choose();
          }}
        >
          <div className="sh-textbox">
            <h1>{START.title}</h1>
          </div>
          <p className="sh-lead">{START.lead}</p>
          <div className="sh-start-actions">
            <Button variant="primary" icon={FolderOpen} onClick={choose} disabled={!!busy}>
              {START.choose}
            </Button>
            <Button icon={FileText} onClick={() => void openSample()} disabled={!!busy}>
              {START.sample}
            </Button>
          </div>
          <p className="sh-accepts">
            {START.accepts} <span className="sh-fine-only">You can also drop one here.</span>
          </p>
          <p className="sh-privacy">
            <ShieldCheck size={20} aria-hidden />
            <span>{START.privacy}</span>
          </p>
          <EngineProgress />
          <ul className="sh-scripts" aria-hidden>
            {START.scripts.map((s) => (
              <li key={s.lang} lang={s.lang} dir={s.dir}>
                {s.text}
              </li>
            ))}
          </ul>
        </section>

        <InstallOffer />

        <section className="sh-about-start" aria-labelledby="sh-how">
          <h2 id="sh-how">{START.stepsTitle}</h2>
          <ol className="sh-steps">
            {START.steps.map((s) => (
              <li key={s.title}>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </li>
            ))}
          </ol>
          <h2>{START.moreTitle}</h2>
          <dl className="sh-facts">
            {START.more.map((m) => (
              <div key={m.title}>
                <dt>{m.title}</dt>
                <dd>{m.text}</dd>
              </div>
            ))}
          </dl>
          <h2>{START.questionsTitle}</h2>
          <div className="sh-faq">
            {START.questions.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="sh-start-foot">
        <a href="https://github.com/TheRealLaksh/pdfedit" target="_blank" rel="noreferrer">
          {START.source}
        </a>
        <a href="https://lakshpradhwani.com" target="_blank" rel="noreferrer">
          {START.author}
        </a>
        {install && (
          <button type="button" className="sh-link" onClick={install}>
            {INSTALL.action}
          </button>
        )}
      </footer>
    </div>
  );
}
