/** The end of the job: name the new copy, share it, save it, or get it under a size limit. */
import { CheckCircle, FilePdf, FloppyDisk, FolderOpen, LockKey, ShareNetwork, Warning } from "@phosphor-icons/react";
import { useRef, useState, type FormEvent } from "react";
import { useStore, type Prepared } from "../../store";
import { canShare, openAnother, pdfFile, saveCopy, shareCopy } from "./actions";
import { Button, Field, Segmented } from "./controls";
import { Modal } from "./Dialogs";
import { FINISH } from "./strings";
import { useShell, type Finish } from "./uiStore";
import { cleanFileName, formatSize } from "./util";

const LIMITS = [100, 200, 500, 1024];
type Choice = 0 | "other" | number;

export function FinishSheet({ finish }: { finish: Finish }) {
  const close = () => useShell.getState().setFinish(null);
  const pages = useStore((s) => s.doc?.pageCount ?? 0);
  const busy = useStore((s) => s.busy !== null);
  const partial = finish.copy.options.pages;
  /** the copy as first made, to go back to without making it again */
  const original = useRef(finish.copy);
  const [copy, setCopy] = useState<Prepared>(finish.copy);
  const [name, setName] = useState(() => finish.copy.name.replace(/\.pdf$/i, ""));
  const [saved, setSaved] = useState(finish.saved);
  const [choice, setChoice] = useState<Choice>(0);
  const [custom, setCustom] = useState("");
  const [limit, setLimit] = useState<number | null>(null);

  const named: Prepared = { ...copy, name: cleanFileName(name, finish.copy.name) };
  const shareable = canShare([pdfFile(named)]);

  /** make the copy again, no larger than `kb` kilobytes if that can be done (0 = as it was) */
  const shrink = async (kb: number) => {
    let next = original.current;
    if (kb > 0 && next.bytes.length > kb * 1024) {
      const made = await useStore.getState().prepare({ ...original.current.options, maxBytes: kb * 1024 }, FINISH.shrinking);
      if (!made) return;
      next = made;
    }
    setLimit(kb || null);
    if (next.bytes !== copy.bytes) setSaved(next === original.current && finish.saved);
    setCopy(next);
  };

  const pick = (value: Choice) => {
    setChoice(value);
    if (value !== "other") void shrink(value);
  };

  const applyCustom = (e: FormEvent) => {
    e.preventDefault();
    const kb = Number(custom);
    if (kb > 0) void shrink(kb);
  };

  const save = () => {
    saveCopy(named);
    setSaved(true);
  };

  const missed = limit !== null && copy.bytes.length > limit * 1024;

  return (
    <Modal
      title={saved ? FINISH.saved : FINISH.ready}
      icon={saved ? <CheckCircle size={24} weight="fill" className="sh-ok" aria-hidden /> : <FilePdf size={24} aria-hidden />}
      onClose={close}
      className="sh-finish"
    >
      <div className="sh-stack">
        <div className="sh-filefield">
          <Field
            label={FINISH.nameLabel}
            name="file-name"
            autoComplete="off"
            spellCheck={false}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <span aria-hidden>.pdf</span>
        </div>
        <p className="sh-hint" data-testid="finish-size">
          {formatSize(copy.bytes.length)}
          {partial ? `, ${partial.length} of ${pages} pages` : `, ${pages} ${pages === 1 ? "page" : "pages"}`}
        </p>
        <div className="sh-finish-main">
          {shareable && (
            <Button variant="primary" icon={ShareNetwork} disabled={busy} data-testid="finish-share" data-autofocus onClick={() => shareCopy(named, close)}>
              {FINISH.share}
            </Button>
          )}
          <Button
            variant={shareable ? "secondary" : "primary"}
            icon={FloppyDisk}
            disabled={busy}
            data-testid="finish-save"
            data-autofocus={shareable ? undefined : true}
            onClick={save}
          >
            {saved ? FINISH.saveAgain : FINISH.save}
          </Button>
        </div>

        <section className="sh-finish-size" aria-label={FINISH.sizeTitle}>
          <Segmented
            label={FINISH.sizeTitle}
            value={choice}
            onChange={pick}
            options={[
              { value: 0, label: FINISH.asIs },
              ...LIMITS.map((kb) => ({ value: kb as Choice, label: kb >= 1024 ? `${kb / 1024} MB` : `${kb} KB` })),
              { value: "other", label: FINISH.custom },
            ]}
          />
          {choice === "other" && (
            <form className="sh-input-group" onSubmit={applyCustom}>
              <input
                className="sh-input"
                inputMode="numeric"
                name="max-size"
                autoComplete="off"
                aria-label={FINISH.customLabel}
                placeholder={FINISH.customLabel}
                value={custom}
                autoFocus
                onChange={(e) => setCustom(e.target.value.replace(/\D/g, ""))}
              />
              <Button type="submit" disabled={busy || !Number(custom)}>
                {FINISH.apply}
              </Button>
            </form>
          )}
          <p className={missed ? "sh-result sh-result-missed" : "sh-result"} role="status">
            {limit === null ? (
              <span className="sh-hint">{FINISH.sizeHint}</span>
            ) : (
              <>
                {missed ? <Warning size={18} weight="fill" aria-hidden /> : <CheckCircle size={18} weight="fill" aria-hidden />}
                <span>
                  {missed
                    ? FINISH.missed(formatSize(copy.bytes.length), formatSize(limit * 1024))
                    : FINISH.reached(formatSize(copy.bytes.length))}
                </span>
              </>
            )}
          </p>
        </section>

        <div className="sh-finish-more">
          {!copy.options.password && (
            <Button
              variant="ghost"
              icon={LockKey}
              onClick={() => {
                close();
                useStore.getState().openPanel("export");
              }}
            >
              {FINISH.password}
            </Button>
          )}
          <Button
            variant="ghost"
            icon={FolderOpen}
            onClick={() => {
              close();
              void openAnother();
            }}
          >
            {FINISH.open}
          </Button>
        </div>
        <Button block onClick={close}>
          {FINISH.keep}
        </Button>
      </div>
    </Modal>
  );
}
