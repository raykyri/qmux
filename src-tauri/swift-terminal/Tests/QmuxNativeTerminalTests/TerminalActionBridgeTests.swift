import GhosttyKit
import Testing
@testable import GhosttyTerminal

@MainActor
struct TerminalActionBridgeTests {
    @Test
    func `clipboard callbacks require a host-approved payload and do not list clipboard types`() {
        let bridge = TerminalCallbackBridge()
        // No C call can occur: unapproved requests must return before completing.
        bridge.rawSurface = UnsafeMutableRawPointer(bitPattern: 1)!
        let userdata = Unmanaged.passUnretained(bridge).toOpaque()
        let state = UnsafeMutableRawPointer(bitPattern: 2)!
        let read = terminalControllerReadClipboardCallback(
            userdata: userdata, clipboard: GHOSTTY_CLIPBOARD_STANDARD,
            statePtr: state, mimes: nil, mimesLen: 0, listAvailable: false
        )
        #expect(read == GHOSTTY_CLIPBOARD_READ_UNAVAILABLE)
        let list = terminalControllerReadClipboardCallback(
            userdata: userdata, clipboard: GHOSTTY_CLIPBOARD_STANDARD,
            statePtr: state, mimes: nil, mimesLen: 0, listAvailable: true
        )
        #expect(list == GHOSTTY_CLIPBOARD_READ_UNSUPPORTED)
    }

    @Test
    func `action bridge reports supported actions without claiming app management`() {
        let bridge = TerminalCallbackBridge()
        var renders = 0
        bridge.onRenderRequest = { renders += 1 }
        var action = ghostty_action_s()
        action.tag = GHOSTTY_ACTION_RENDER
        #expect(bridge.handleAction(action))
        #expect(renders == 1)
        action.tag = GHOSTTY_ACTION_NEW_WINDOW
        #expect(!bridge.handleAction(action))
        #expect(renders == 1)
    }
}
