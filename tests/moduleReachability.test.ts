import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { unreachableModules } from "../scripts/check-unused-modules.mjs";

function fixture(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "qmux-reachability-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents);
  }
  return {
    file: (name: string) => join(directory, name),
    sources: Object.keys(files).map((name) => join(directory, name)),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("reachability follows lazy imports, type imports, re-exports, and cycles", () => {
  const files = fixture({
    "main.ts": 'import type { Model } from "./model"; export * from "./barrel"; void import("./lazy");',
    "model.ts": "export interface Model { id: string }",
    "barrel.ts": 'export * from "./leaf";',
    "leaf.ts": 'export * from "./barrel";',
    "lazy.ts": 'type Imported = import("./inline-type").Inline;',
    "inline-type.ts": "export type Inline = string;",
    "unused.ts": "export const unused = true;",
  });
  try {
    assert.deepEqual(unreachableModules(files.sources, [files.file("main.ts")]), [files.file("unused.ts")]);
  } finally {
    files.cleanup();
  }
});

test("server and test entrypoints retain their own dependency trees", () => {
  const files = fixture({
    "app.ts": "export {};",
    "server.ts": 'import "./server-helper";',
    "server-helper.ts": "export {};",
    "helper.test.ts": 'import "./test-helper";',
    "test-helper.ts": "export {};",
  });
  try {
    assert.deepEqual(unreachableModules(files.sources, [
      files.file("app.ts"), files.file("server.ts"), files.file("helper.test.ts"),
    ]), []);
  } finally {
    files.cleanup();
  }
});

test("a cycle without an entrypoint does not keep itself alive", () => {
  const files = fixture({
    "app.ts": "export {};",
    "a.ts": 'import "./b";',
    "b.ts": 'import "./a";',
  });
  try {
    assert.deepEqual(unreachableModules(files.sources, [files.file("app.ts")]), [files.file("a.ts"), files.file("b.ts")]);
  } finally {
    files.cleanup();
  }
});
