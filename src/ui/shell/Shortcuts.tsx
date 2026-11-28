/** Desktop keyboard help and the single-letter tool keys. */
import { Keyboard } from "@phosphor-icons/react";
import { useEffect } from "react";
import { useStore } from "../../store";
import { chooseTool } from "./actions";
import { Button, Check } from "./controls";
import { Modal } from "./Dialogs";
import { KEYS } from "./strings";
import { RAIL, TOOLS } from "./tools";
import { useShell } from "./uiStore";

/** places where a letter is text, not a command */
const TYPING = "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=dialog], [role=menu], [role=listbox]";

/**
 * V, E, T and friends pick tools, B shows the page thumbnails, ? lists everything. Only with a document
 * open, outside text fields and dialogs, and not at all once switched off (WCAG 2.1.4).
 */
export function useToolKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const state = useStore.getState();
      const shell = useShell.getState();
      if (!shell.letterKeys || !state.doc || state.image || state.editing || state.busy) return;
      if ((e.target as Element).closest?.(TYPING) || document.querySelector("[aria-modal=true]")) return;
      if (e.key === "?") {
        e.preventDefault();
        shell.setKeysOpen(true);
        return;
      }
      if (e.shiftKey) return;
      const key = e.key.toUpperCase();
      if (key === "B") {
        e.preventDefault();
        shell.setSidebar(!shell.sidebar);
        return;
      }
      const tool = Object.values(TOOLS).find((t) => t.key === key);
      if (tool) {
        e.preventDefault();
        chooseTool(tool.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function ShortcutsDialog() {
  const close = () => useShell.getState().setKeysOpen(false);
  const letters = useShell((s) => s.letterKeys);
  const setLetters = useShell((s) => s.setLetterKeys);
  const tools = RAIL.filter((id) => id !== null).map((id) => TOOLS[id]);
  return (
    <Modal title={KEYS.title} onClose={close} icon={<Keyboard size={22} aria-hidden />} className="sh-keysdialog">
      <div className="sh-stack">
        <div className="sh-keycolumns">
          <section>
            <h3>{KEYS.general}</h3>
            <dl className="sh-keys">
              {KEYS.rows.map(([what, key]) => (
                <div key={what}>
                  <dt>{what}</dt>
                  <dd>
                    <kbd>{key}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <section data-off={!letters || undefined}>
            <h3>{KEYS.tools}</h3>
            <dl className="sh-keys">
              {tools.map((t) => (
                <div key={t.id}>
                  <dt>{t.label}</dt>
                  <dd>
                    <kbd>{t.key}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
        <Check label={KEYS.singleKeys} hint={KEYS.singleKeysHint} checked={letters} onChange={setLetters} />
        <div className="sh-actions">
          <Button variant="primary" onClick={close} data-autofocus>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}
