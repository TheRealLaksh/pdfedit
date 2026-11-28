/** Unsaved work found on this device (a closed or discarded tab): offer to carry on, or delete it. */
import { ClockCounterClockwise, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { clearDraft, loadDraft, setDraftsEnabled, type DraftInfo } from "../../engine/client";
import { useStore } from "../../store";
import { Button, Check, IconButton } from "./controls";
import { DRAFT } from "./strings";
import { remember, remembered } from "./uiStore";
import { ago } from "./util";

// the switch in About is honoured from the first change on
if (!remembered("drafts", true)) void setDraftsEnabled(false);

export function DraftCard() {
  const [draft, setDraft] = useState<DraftInfo | null>(null);
  const busy = useStore((s) => s.busy !== null);
  const resume = useStore((s) => s.resumeDraft);

  useEffect(() => {
    let live = true;
    void loadDraft().then((found) => live && setDraft(found));
    return () => {
      live = false;
    };
  }, []);

  if (!draft) return null;
  const remove = () => {
    setDraft(null);
    void clearDraft();
    useStore.getState().toast(DRAFT.removed);
  };
  return (
    <aside className="sh-draft" aria-labelledby="sh-draft-title">
      <ClockCounterClockwise size={22} aria-hidden />
      <div className="sh-draft-text">
        <h2 id="sh-draft-title">{DRAFT.heading}</h2>
        <p>
          <strong>{draft.fileName}</strong>, {ago(draft.savedAt)}. {DRAFT.kept}
        </p>
      </div>
      <span className="sh-draft-actions">
        <Button variant="primary" disabled={busy} onClick={() => void resume()}>
          {DRAFT.resume}
        </Button>
        <IconButton icon={Trash} label={DRAFT.remove} disabled={busy} onClick={remove} />
      </span>
    </aside>
  );
}

export function DraftSwitch() {
  const [on, setOn] = useState(() => remembered("drafts", true));
  return (
    <Check
      label={DRAFT.setting}
      hint={DRAFT.settingHint}
      checked={on}
      onChange={(next) => {
        setOn(next);
        remember("drafts", next);
        void setDraftsEnabled(next);
      }}
    />
  );
}
