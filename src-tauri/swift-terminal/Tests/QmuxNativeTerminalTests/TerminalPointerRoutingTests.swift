import XCTest
@testable import QmuxNativeTerminal

final class TerminalPointerRoutingTests: XCTestCase {
    func testFirstClickReachesWebActivation() {
        XCTAssertTrue(shouldForwardTerminalLeftMouseDownToWeb(clickCount: 1))
    }

    func testSecondAndLaterClicksStayNative() {
        XCTAssertFalse(shouldForwardTerminalLeftMouseDownToWeb(clickCount: 2))
        XCTAssertFalse(shouldForwardTerminalLeftMouseDownToWeb(clickCount: 3))
        XCTAssertFalse(shouldForwardTerminalLeftMouseDownToWeb(clickCount: 4))
    }

    func testSingleLeftClickDefersKeyboardRestoreUntilMouseUp() {
        XCTAssertTrue(shouldDeferTerminalKeyboardRestore(isLeftMouseDown: true, clickCount: 1))
        XCTAssertFalse(shouldDeferTerminalKeyboardRestore(isLeftMouseDown: true, clickCount: 2))
        XCTAssertFalse(shouldDeferTerminalKeyboardRestore(isLeftMouseDown: true, clickCount: 3))
        XCTAssertFalse(shouldDeferTerminalKeyboardRestore(isLeftMouseDown: false, clickCount: 1))
    }

    func testDeferredKeyboardRestoreWaitsForTheRelease() {
        XCTAssertFalse(shouldRestoreDeferredTerminalKeyboard(
            restorePending: true,
            isPointerDown: true,
            isPointerUp: false,
            noButtonsPressed: false
        ))
        XCTAssertFalse(shouldRestoreDeferredTerminalKeyboard(
            restorePending: false,
            isPointerDown: false,
            isPointerUp: true,
            noButtonsPressed: true
        ))
        XCTAssertTrue(shouldRestoreDeferredTerminalKeyboard(
            restorePending: true,
            isPointerDown: false,
            isPointerUp: true,
            noButtonsPressed: false
        ))
        XCTAssertTrue(shouldRestoreDeferredTerminalKeyboard(
            restorePending: true,
            isPointerDown: false,
            isPointerUp: false,
            noButtonsPressed: true
        ))
        XCTAssertFalse(shouldRestoreDeferredTerminalKeyboard(
            restorePending: true,
            isPointerDown: false,
            isPointerUp: false,
            noButtonsPressed: false
        ))
    }
}
