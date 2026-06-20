import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ensureGhosttyReady } from "./lib/ghostty";
import { loadTerminalFont } from "./lib/terminalFont";
import "./styles.css";

// Start instantiating the Ghostty WASM terminal engine during app boot so it is
// ready well before the user spawns the first pane. Errors surface when a pane
// actually tries to use it; this is just a warm-up.
void ensureGhosttyReady().catch(() => {});
void loadTerminalFont().catch(() => {});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
