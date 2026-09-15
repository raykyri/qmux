import ReactDOM from "react-dom/client";
import App from "./App";
import { loadTerminalFont } from "./lib/terminalFont";
import "./styles.css";

// Start loading the bundled terminal font during app boot so pane sizing can use
// stable metrics before the first terminal is opened.
void loadTerminalFont().catch(() => {});

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("ui-catalog")) {
  void import("./components/ui/ComponentCatalog").then(({ default: ComponentCatalog }) => {
    root.render(<ComponentCatalog />);
  });
} else {
  root.render(<App />);
}
