import XCTest
@testable import QmuxNativeTerminal

final class TerminalWebPointerClaimTests: XCTestCase {
    func testBridgeModesMatchRustAndRejectUnknownValues() {
        XCTAssertEqual(TerminalWebPointerClaim(rawValue: 0), .released)
        XCTAssertEqual(TerminalWebPointerClaim(rawValue: 1), .gesture)
        XCTAssertEqual(TerminalWebPointerClaim(rawValue: 2), .overlay)
        XCTAssertNil(TerminalWebPointerClaim(rawValue: -1))
        XCTAssertNil(TerminalWebPointerClaim(rawValue: 3))
    }

    func testOverlayOpenedDuringAPressSurvivesEveryRelease() {
        var claim = TerminalWebPointerClaim.overlay
        for _ in 0..<3 {
            XCTAssertTrue(claim.routeToWeb(isPointerUp: false))
            XCTAssertTrue(claim.routeToWeb(isPointerUp: true))
            XCTAssertEqual(claim, .overlay)
        }
        claim = .released
        XCTAssertFalse(claim.routeToWeb(isPointerUp: false))
    }

    func testGestureForwardsItsOwnReleaseThenRetires() {
        var claim = TerminalWebPointerClaim.gesture
        XCTAssertTrue(claim.routeToWeb(isPointerUp: false))
        XCTAssertTrue(claim.routeToWeb(isPointerUp: true))
        XCTAssertEqual(claim, .released)
        XCTAssertFalse(claim.routeToWeb(isPointerUp: true))
    }

    func testBlurOrInterruptedInputRetiresOnlyGestures() {
        var gesture = TerminalWebPointerClaim.gesture
        var overlay = TerminalWebPointerClaim.overlay
        gesture.retireGesture()
        overlay.retireGesture()
        XCTAssertEqual(gesture, .released)
        XCTAssertEqual(overlay, .overlay)
    }

    func testOverlayDowngradeAndReassertAfterNativeRetirement() {
        var claim = TerminalWebPointerClaim.gesture
        claim.retireGesture()
        claim = .overlay
        XCTAssertTrue(claim.routeToWeb(isPointerUp: true))
        claim = .gesture // Final overlay released, another drag still live in JS.
        XCTAssertTrue(claim.routeToWeb(isPointerUp: true))
        XCTAssertFalse(claim.routeToWeb(isPointerUp: false))
        claim = .gesture // New gesture publishes despite an old JS claim.
        XCTAssertTrue(claim.routeToWeb(isPointerUp: false))
    }

    func testReloadAndShutdownReleaseBothKindsBeforeRepublishing() {
        for initial in [TerminalWebPointerClaim.gesture, .overlay] {
            var claim = initial
            claim = .released // Host resets the document-owned state.
            XCTAssertFalse(claim.routeToWeb(isPointerUp: false))
            claim = .overlay // Replacement document's mounted overlay.
            XCTAssertTrue(claim.routeToWeb(isPointerUp: true))
        }
    }
}
