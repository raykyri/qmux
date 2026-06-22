import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    chunkSizeWarningLimit: 2048,
  },
  // The dictation Whisper model runs in a module worker (src/whisperWorker.ts)
  // via transformers.js. Keep it out of esbuild's dev pre-bundle: it ships its
  // own ESM worker/wasm assets that the optimizer mangles.
  optimizeDeps: { exclude: ["@huggingface/transformers"] },
});
