This is qmux, a terminal for managing coding and research agents.
For commit messages, include a short description followed by a
paragraph or bullet-point list of details about what was committed.
Use multiple -m arguments instead of \n to break lines in commits.
Don't ask to re-run 'cargo test' if there is a test that fails because
of your sandboxing permissions, unless your work involves that test.

App-level keyboard shortcuts must work while a native Ghostty terminal
is focused, and Ghostty's AppKit layer swallows any Command chord that
reaches event dispatch, even chords Ghostty has no binding for. If
Ghostty binds the chord by default, add a `keybind ...=unbind` entry
to the override list in
src-tauri/swift-terminal/Sources/QmuxNativeTerminal/NativeTerminalPane.swift.
Note that unbinding alone is not enough to reclaim a chord for qmux;
use QmuxTerminalView.performKeyEquivalent to offer Command chords to
qmux classifiers before Ghostty can capture them. System
window-management chords (Cmd-H hide, Cmd-Option-H hide others, Cmd-M
minimize) are exempted in that override so they fall through to the
app menu instead of dying in Ghostty's catch-all.