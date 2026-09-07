# Vendored wry integrity manifest

The `vendor/wry` directory contains a modified copy of [wry](https://github.com/tauri-apps/wry)
used via a `[patch.crates-io]` override in `src-tauri/Cargo.toml`.

Because this is a local copy rather than a crates.io dependency, any edit to
`vendor/wry` silently changes the WebView layer for every build.  The
artifacts in this directory exist to make those changes auditable and
verifiable.

## Upstream base

| Field | Value |
|-------|-------|
| Repository | `https://github.com/tauri-apps/wry` |
| Base commit | `a5bf203a1c8dbb3583588382538d6521655222a8` |
| Tag / version | `v0.55.1` |

## Local modifications

The diff between the upstream base and this vendored copy is recorded in
`vendor/wry.patch` (source files only; the auto-generated `Cargo.toml` is
excluded because cargo rewrites it during publication).

The modifications are:

1. **Panic hardening in the macOS URL-scheme handler**
   (`src/wkwebview/class/url_scheme_handler.rs`) — wraps the Objective-C FFI
   callbacks (`start_task`, `stop_task`, `didReceiveResponse`,
   `didReceiveData`, `didFinish`) in `catch_unwind` / `objc2::exception::catch`
   so a Rust panic or ObjC exception cannot unwind across the FFI boundary and
   abort the process.

2. **Modernized drag-and-drop file collection**
   (`src/wkwebview/drag_drop.rs`) — reads file URLs from `NSPasteboardItem`
   instead of the deprecated `NSFilenamesPboardType` property list.

3. **Modernized event modifier flags**
   (`src/wkwebview/synthetic_mouse_events.rs`) — replaces legacy
   `NSControlKeyMask` / `NSAlternateKeyMask` / `NSShiftKeyMask` /
   `NSCommandKeyMask` aliases with `NSEventModifierFlags::Control` /
   `::Option` / `::Shift` / `::Command`.

4. **Removed redundant `unsafe` blocks** exposed by updated `objc2` bindings
   (`wry_web_view_parent.rs`, `wry_web_view_ui_delegate.rs`, `mod.rs`).

5. **Added `NSPasteboardItem` feature** to the `objc2-app-kit` dependency
   in `Cargo.toml`.

## Verification

Run `scripts/verify-vendor-wry.sh` to confirm that the vendored copy matches
the recorded patch.  The script fetches the upstream commit, diffs the source
files, and compares the result to `vendor/wry.patch`.

```sh
scripts/verify-vendor-wry.sh
```

The script exits `0` when the vendored source matches the recorded patch and
`1` on any mismatch.  Run it in CI and after any manual edit to `vendor/wry`.

## Updating the patch

If you intentionally modify `vendor/wry`, regenerate the patch:

```sh
scripts/verify-vendor-wry.sh --update
```

This overwrites `vendor/wry.patch` with the current diff.  Commit the updated
patch alongside the source changes and document the reason in the commit
message.
