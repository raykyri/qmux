import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);

export default defineConfig({
  plugins: [react()],
  define: {
    // MathJax's version probe falls back to eval('require') when this global
    // is missing; the app's CSP has no 'unsafe-eval', so the fallback would
    // throw while the math chunk loads. Defining it turns that branch into
    // statically dead code the bundler drops.
    PACKAGE_VERSION: JSON.stringify(
      (require("mathjax-full/package.json") as { version: string }).version,
    ),
  },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    chunkSizeWarningLimit: 2048,
  },
});
