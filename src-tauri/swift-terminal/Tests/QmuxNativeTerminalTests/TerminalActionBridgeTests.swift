import GhosttyKit
import Testing
@testable import GhosttyTerminal

@MainActor
struct TerminalActionBridgeTests {
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
