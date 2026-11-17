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
}
