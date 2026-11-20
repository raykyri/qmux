/// The native terminal and transparent WebKit host both observe the first left
/// mouse-down so React can activate the pane that Ghostty received the click in.
/// Later clicks select a word or line in Ghostty. Forwarding them to WebKit
/// can also create a DOM selection and release the terminal's keyboard focus.
func shouldForwardTerminalLeftMouseDownToWeb(clickCount: Int) -> Bool {
    clickCount == 1
}

/// A press WebKit also receives can start a scrubber drag. Restoring the
/// terminal as first responder before mouse-up pointer-cancels that drag.
/// Later clicks stay in Ghostty, so they can restore on the next turn.
func shouldDeferTerminalKeyboardRestore(isLeftMouseDown: Bool, clickCount: Int) -> Bool {
    isLeftMouseDown && shouldForwardTerminalLeftMouseDownToWeb(clickCount: clickCount)
}

/// The deferred restore runs on the gesture's own release, and also on any
/// later event that proves the button never delivered its release.
func shouldRestoreDeferredTerminalKeyboard(
    restorePending: Bool,
    isPointerDown: Bool,
    isPointerUp: Bool,
    noButtonsPressed: Bool
) -> Bool {
    restorePending && !isPointerDown && (isPointerUp || noButtonsPressed)
}

/// C-ABI probe used by the Rust suite because Command Line Tools installations
/// can compile the Swift bridge but do not include XCTest.
@_cdecl("qmux_native_terminal_should_forward_left_mouse_down_to_web")
public func qmuxNativeTerminalShouldForwardLeftMouseDownToWeb(
    _ clickCount: Int32
) -> Int32 {
    shouldForwardTerminalLeftMouseDownToWeb(clickCount: Int(clickCount)) ? 1 : 0
}
