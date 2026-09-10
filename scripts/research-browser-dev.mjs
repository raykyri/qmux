#!/usr/bin/env node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(process.argv[2] || repo);
if (!(await stat(root)).isDirectory())
  throw new Error("Pass a directory containing an HTML entry point");
const server = await createServer({
  configFile: false,
  root,
  plugins: [react()],
  define: {
    PACKAGE_VERSION: JSON.stringify(
      require("mathjax-full/package.json").version,
    ),
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "/@qmux/sdk": resolve(repo, "src/research-browser/sdk.ts"),
      "@qmux/research-browser": resolve(repo, "src/research-browser/sdk.ts"),
      react: resolve(repo, "node_modules/react"),
      "react-dom": resolve(repo, "node_modules/react-dom"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1421,
    strictPort: true,
    fs: { allow: [repo, root] },
  },
});
await server.listen();
console.log(
  `Research Browser: http://127.0.0.1:1421/${root === resolve(repo) ? "research-browser.html" : ""}`,
);
console.log("In qmux, open Research Browser → View source and load that URL.");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
