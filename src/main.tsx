import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { warmUpEngine } from "./engine/client";
import { useStore } from "./store";
import { prefetchEngine } from "./ui/shell/boot";
import "./ui/tokens.css";

// the engine starts once it has been downloaded (choosing a file earlier starts it at once)
void prefetchEngine().finally(warmUpEngine);
// test hook: lets end-to-end tests read state; contains nothing secret
Object.assign(window, { __pdfedit: useStore });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
