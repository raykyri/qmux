import AppKit
import XCTest
@testable import QmuxNativeTerminal

@MainActor
final class HumanBrowserSurfaceTests: XCTestCase {
    func testHideCollapsesAndReopenRestoresNativeFrame() {
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 800, height: 600),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let view = NSView()
        window.contentView!.addSubview(view)
        let rect = CGRect(x: 20, y: 40, width: 400, height: 300)
        XCTAssertTrue(applyHumanBrowserSurface(view, rect: rect, visible: true, retire: false))
        XCTAssertEqual(view.frame, CGRect(x: 20, y: 260, width: 400, height: 300))
        XCTAssertTrue(applyHumanBrowserSurface(view, rect: .zero, visible: false, retire: false))
        XCTAssertTrue(view.isHidden)
        XCTAssertEqual(view.frame.size, .zero)
        XCTAssertNotNil(view.superview)
        XCTAssertTrue(applyHumanBrowserSurface(view, rect: rect, visible: true, retire: false))
        XCTAssertFalse(view.isHidden)
        XCTAssertEqual(view.frame.size, rect.size)
    }

    func testRetirementDetachesAndCannotBeReshown() {
        let parent = NSView(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
        let view = NSView(frame: parent.bounds)
        parent.addSubview(view)
        XCTAssertTrue(applyHumanBrowserSurface(view, rect: .zero, visible: false, retire: true))
        XCTAssertNil(view.superview)
        XCTAssertTrue(view.isHidden)
        XCTAssertEqual(view.frame.size, .zero)
        XCTAssertTrue(applyHumanBrowserSurface(view, rect: .zero, visible: false, retire: true))
        XCTAssertFalse(applyHumanBrowserSurface(view, rect: parent.bounds, visible: true, retire: false))
    }
}
