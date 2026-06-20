import { init } from "ghostty-web";

// ghostty-web compiles Ghostty's VT parser to WebAssembly. The module must be
// instantiated once (it loads the WASM from a base64 data URL baked into the JS
// bundle, so there is no separate asset to serve) before any Terminal is
// constructed. We cache the promise so every pane shares a single instance and
// we never re-run instantiation.
let readyPromise: Promise<void> | null = null;

export function ensureGhosttyReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = init().catch((error) => {
      // Reset so a later pane can retry instead of being stuck on a rejected promise.
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}
