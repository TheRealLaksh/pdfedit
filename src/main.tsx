import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { warmUpEngine } from "./engine/client";
import { useStore } from "./store";
import "./ui/tokens.css";

warmUpEngine();
// test hook: lets end-to-end tests read state; contains nothing secret
Object.assign(window, { __pdfedit: useStore });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
