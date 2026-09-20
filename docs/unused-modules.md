# Unused-module enforcement

`npm run check:unused` (`scripts/check-unused-modules.mjs`) walks static,
type-only, re-export and literal dynamic imports from every entrypoint and
fails when a first-party TypeScript module under `src/` or `web/` is reachable
from none of them.

## Roots

- `src/main.tsx` — the desktop app. There is no second webview entry; the
  global task launcher renders inside the main window's tree.
- `web/server.tsx` — the separately bundled marketing site.
- every `tests/**/*.test.ts(x)` and `web/**/*.test.ts(x)` file. Tests are
  deliberate roots: a helper that backs an independent contract must not become
  deletable merely because the current UI does not import it.

## The standing rule

**A missing frontend caller alone does not establish that a registered backend
command or a persisted field can safely be removed.** The check covers
TypeScript module reachability and nothing else. A Tauri command may be invoked
by the CLI, a plugin, or a future surface, and a persisted field may still be
read back from state written by an older build. Removing either needs its own
evidence.

## Fixing a report

Wire the module into a real caller or a test, or delete it. Do not add it to an
ignore list — the check has none by design.

## Related checks

`npm run check` runs `check:types` (`tsc` for `src/`, then `tsc -p
web/tsconfig.json`), then `check:unused`, then `format`. Note that `npm run
format` in this repository is `cargo fmt --check`: a **Rust** format check, not
a TypeScript formatter. `npm run preflight` adds the full `npm test` chain.
