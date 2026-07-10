import GhosttyTerminal

/// C-ABI probe used by Rust to verify that the Swift wrapper and libghostty
/// binary were linked into the application. The real host API is added beside
/// this function so all Ghostty pointers remain owned by the main-actor Swift
/// layer rather than crossing into `Send + Sync` Rust state.
@_cdecl("qmux_native_terminal_bridge_available")
public func qmuxNativeTerminalBridgeAvailable() -> Int32 {
    // Referencing a public GhosttyTerminal type makes the bridge fail at link
    // time if the package product or its binary framework is missing.
    _ = TerminalSurfaceOptions()
    return 1
}
