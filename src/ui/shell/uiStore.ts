/** State that only the shell cares about (dialogs and menus). Document state lives in src/store. */
import { create } from "zustand";
import type { Prepared } from "../../store";

export interface ConfirmChoice {
  id: string;
  label: string;
  tone?: "primary" | "danger" | "plain";
}

export interface ConfirmRequest {
  title: string;
  message: string;
  choices: ConfirmChoice[];
  resolve(id: string | null): void;
}

export interface PromptRequest {
  title: string;
  message: string;
  label: string;
  type: "text" | "password";
  submit: string;
  resolve(value: string | null): void;
}

/** the finish sheet: a copy ready to be saved or shared */
export interface Finish {
  copy: Prepared;
  /** already saved to the device (one click on a computer, or Save in the sheet) */
  saved: boolean;
}

/** what the browser offers when the app can be installed (Chromium only) */
export interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** a small on/off choice remembered on this device */
export function remembered(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem("pdfedit." + key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}
export function remember(key: string, value: boolean): void {
  try {
    localStorage.setItem("pdfedit." + key, value ? "1" : "0");
  } catch {
    /* private mode */
  }
}

interface ShellState {
  finish: Finish | null;
  /** keyboard shortcut list */
  keysOpen: boolean;
  /** single-letter tool keys can be turned off (WCAG 2.1.4) */
  letterKeys: boolean;
  /** page thumbnails beside the page on wide screens */
  sidebar: boolean;
  install: InstallEvent | null;
  setFinish(finish: Finish | null): void;
  setKeysOpen(open: boolean): void;
  setLetterKeys(on: boolean): void;
  setSidebar(on: boolean): void;
  menuOpen: boolean;
  confirm: ConfirmRequest | null;
  prompt: PromptRequest | null;
  setMenu(open: boolean): void;
}

export const useShell = create<ShellState>()((set) => ({
  finish: null,
  keysOpen: false,
  letterKeys: remembered("letter-keys", true),
  sidebar: remembered("sidebar", true),
  install: null,
  setFinish: (finish) => set({ finish }),
  setKeysOpen: (keysOpen) => set({ keysOpen, menuOpen: false }),
  setLetterKeys: (letterKeys) => {
    remember("letter-keys", letterKeys);
    set({ letterKeys });
  },
  setSidebar: (sidebar) => {
    remember("sidebar", sidebar);
    set({ sidebar });
  },
  menuOpen: false,
  confirm: null,
  prompt: null,
  setMenu: (menuOpen) => set({ menuOpen }),
}));

/** resolves with the chosen id, or null when dismissed */
export function ask(request: Omit<ConfirmRequest, "resolve">): Promise<string | null> {
  useShell.getState().confirm?.resolve(null);
  return new Promise((resolve) => {
    useShell.setState({
      confirm: {
        ...request,
        resolve: (id) => {
          useShell.setState({ confirm: null });
          resolve(id);
        },
      },
    });
  });
}

/** resolves with the typed value, or null when dismissed */
export function promptFor(request: Omit<PromptRequest, "resolve">): Promise<string | null> {
  useShell.getState().prompt?.resolve(null);
  return new Promise((resolve) => {
    useShell.setState({
      prompt: {
        ...request,
        resolve: (value) => {
          useShell.setState({ prompt: null });
          resolve(value);
        },
      },
    });
  });
}
