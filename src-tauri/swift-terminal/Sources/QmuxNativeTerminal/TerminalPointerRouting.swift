/// The native terminal and transparent WebKit host both observe the first left
/// mouse-down so React can activate the pane that Ghostty received the click in.
/// Later clicks select a word or line in Ghostty. Forwarding them to WebKit
/// can also create a DOM selection and release the terminal's keyboard focus.
func shouldForwardTerminalLeftMouseDownToWeb(clickCount: Int) -> Bool {
    clickCount == 1
}

/// C-ABI probe used by the Rust suite because Command Line Tools installations
/// can compile the Swift bridge but do not include XCTest.
@_cdecl("qmux_native_terminal_should_forward_left_mouse_down_to_web")
public func qmuxNativeTerminalShouldForwardLeftMouseDownToWeb(
    _ clickCount: Int32
) -> Int32 {
    shouldForwardTerminalLeftMouseDownToWeb(clickCount: Int(clickCount)) ? 1 : 0
}
