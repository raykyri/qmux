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

6. **Handle nullable WebKit callback data during teardown**
   (`wry_web_view_ui_delegate.rs`, `wry_web_view_delegate.rs`,
   `wry_download_delegate.rs`, `navigation.rs`, `download.rs`) — popup policy
   runs without requiring an attached window; unmanaged popup creation is
   declined if the originating window or screen is gone. Missing request URLs
   cancel navigation/download decisions or drop notifications instead of
   panicking across Objective-C. Failed downloads accept nullable resume data
   as declared by `WKDownloadDelegate`, avoiding a null Rust reference.

7. **Handle absent page metadata and non-JSON JavaScript results**
   (`mod.rs`, `document_title_changed_observer.rs`,
   `wry_navigation_delegate.rs`, `navigation.rs`) — reading an unset URL returns
   an error; a nullable title clears the title instead of dereferencing nil.
   Load callbacks accept nullable navigation objects. JavaScript callback
   results are validated before Foundation serializes them, avoiding native
   exceptions for NaN, infinity, dates, and nested non-JSON values. Unsupported
   results use the existing empty-string failure result; valid JSON scalars,
   arrays, and objects retain their normal representation.

8. **Read custom-protocol request streams safely**
   (`url_scheme_handler.rs`) — use a bounded initialized buffer and handle
   signed read counts explicitly. EOF ends the read; a stream error closes the
   stream and fails the WebKit task without forwarding a partial body. This
   avoids unchecked vector lengths, repeated EOF reads, and unfinished tasks.

9. **Complete failed custom-protocol requests without disturbing replacements**
   (`url_scheme_handler.rs`, `wry_web_view.rs`) — malformed requests, missing
   handlers, and application panics fail the active task. Delayed responders
   also contain Rust panics and reject invalid response metadata. Completion
   and failure retire the exact task UUID before notifying WebKit, so a
   reentrant replacement survives and cancelled tasks receive no later
   completion. Disposing a view during response delivery also suppresses
   subsequent callbacks.

## Verification

Run `scripts/verify-vendor-wry.sh` to confirm that the vendored copy matches
the recorded patch.  The script fetches the upstream commit, diffs the source
files, and compares the result to `vendor/wry.patch`.

```sh
scripts/verify-vendor-wry.sh
```

The script exits `0` when the vendored source matches the recorded patch and
`1` on any mismatch.  Run it in CI and after any manual edit to `vendor/wry`.

On macOS, `npm run test:native-browser` exercises detached popup views, missing
navigation/download URLs, nullable download resume data, absent page metadata,
real JavaScript evaluation results, request-body stream failures, and custom
protocol failures, cancellation, and reentrant completion against the app's
compiled Wry library.
Its standalone runner owns AppKit's main thread and needs Command Line Tools,
without requiring the full Xcode XCTest runner. Pass `-- url`, `-- title`,
`-- navigation`, `-- eval`, `-- streams`, or `-- protocols` to run a single
group alone.

## Updating the patch

If you intentionally modify `vendor/wry`, regenerate the patch:

```sh
scripts/verify-vendor-wry.sh --update
```

This overwrites `vendor/wry.patch` with the current diff.  Commit the updated
patch alongside the source changes and document the reason in the commit
message.
