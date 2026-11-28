/**
 * The back gesture on phones and tablets. While there is something it could destroy (an open sheet, a line
 * being typed, changes not downloaded) one extra history entry is kept, so Back takes that away one layer
 * at a time instead of leaving the page. iOS has no "leave this page?" warning, so this is the only guard.
 */
import { useEffect } from "react";
import { useStore } from "../../store";
import { editors } from "../viewer/editor/controller";
import { closeDocument } from "./actions";
import { useMediaQuery } from "./hooks";
import { useShell } from "./uiStore";

const guarded = () => !!history.state?.pdfeditSheet;
const guard = () => {
  if (!guarded()) history.pushState({ pdfeditSheet: true }, "");
};

/** is there anything Back must not throw away right now? */
function needed(phone: boolean, handheld: boolean): boolean {
  const { doc, dirty, editing, panel } = useStore.getState();
  const shell = useShell.getState();
  if (phone && (editing !== null || panel !== null || shell.menuOpen || shell.finish !== null)) return true;
  return handheld && doc !== null && dirty;
}

/** deal with the topmost layer */
function back(phone: boolean): void {
  const state = useStore.getState();
  const shell = useShell.getState();
  if (shell.prompt) shell.prompt.resolve(null);
  else if (shell.confirm) shell.confirm.resolve(null);
  else if (state.passwordPrompt) state.cancelPassword();
  else if (shell.finish) shell.setFinish(null);
  else if (phone && state.editing) {
    // saves what was typed, like tapping Done
    if (editors.current) editors.current.commit();
    else state.stopEditing();
  } else if (phone && (shell.menuOpen || state.panel)) {
    shell.setMenu(false);
    state.openPanel(null);
  } else if (state.doc && state.dirty) void closeDocument();
}

export function useBackGuard(phone: boolean): void {
  const coarse = useMediaQuery("(pointer: coarse)");
  const handheld = phone || coarse;
  const doc = useStore((s) => s.doc !== null);
  const dirty = useStore((s) => s.dirty);
  const editing = useStore((s) => s.editing !== null);
  const panel = useStore((s) => s.panel !== null);
  const menu = useShell((s) => s.menuOpen || s.finish !== null);
  const active = (phone && (editing || panel || menu)) || (handheld && doc && dirty);

  useEffect(() => {
    /** true while an entry we no longer need is being taken off again */
    let removing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onPop = (event: PopStateEvent) => {
      // arriving on a guard entry (forward) is not a request to go back
      if ((event.state as { pdfeditSheet?: boolean } | null)?.pdfeditSheet) return;
      if (removing) removing = false;
      else if (needed(phone, handheld)) back(phone);
      // whatever is still at risk gets its entry again
      clearTimeout(timer);
      timer = setTimeout(() => needed(phone, handheld) && guard());
    };
    // deferred: switching from the menu to a panel keeps the same entry
    const release = () =>
      setTimeout(() => {
        if (removing || needed(phone, handheld) || !guarded()) return;
        removing = true;
        history.back();
      });
    window.addEventListener("popstate", onPop);
    window.addEventListener("pdfedit:release-back", release);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("pdfedit:release-back", release);
    };
  }, [phone, handheld]);

  useEffect(() => {
    if (active) guard();
    else window.dispatchEvent(new Event("pdfedit:release-back"));
  }, [active]);
}
