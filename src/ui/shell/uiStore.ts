/** State that only the shell cares about (dialogs and menus). Document state lives in src/store. */
import { create } from "zustand";

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

interface ShellState {
  menuOpen: boolean;
  confirm: ConfirmRequest | null;
  prompt: PromptRequest | null;
  setMenu(open: boolean): void;
}

export const useShell = create<ShellState>()((set) => ({
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
