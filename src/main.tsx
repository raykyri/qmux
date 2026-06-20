import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { loadTerminalFont } from "./lib/terminalFont";
import "./styles.css";

// Start loading the bundled terminal font during app boot so pane sizing can use
// stable metrics before the first terminal is opened.
void loadTerminalFont().catch(() => {});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
