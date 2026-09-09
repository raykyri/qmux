import AppKit
import Foundation
import XCTest
@testable import QmuxNativeTerminal

@MainActor
final class NativeTerminalLayoutTests: XCTestCase {
    func testClearScreenChordIsOnlyBareCommandK() throws {
        func event(
            _ modifiers: NSEvent.ModifierFlags,
            characters: String = "k"
        ) throws -> NSEvent {
            try XCTUnwrap(
                NSEvent.keyEvent(
                    with: .keyDown,
                    location: .zero,
                    modifierFlags: modifiers,
                    timestamp: 1,
                    windowNumber: 0,
                    context: nil,
                    characters: characters,
                    charactersIgnoringModifiers: characters,
                    isARepeat: false,
                    keyCode: 40
                )
            )
        }

        XCTAssertTrue(QmuxTerminalView.isClearScreenChord(try event(.command)))
        XCTAssertTrue(
            QmuxTerminalView.isClearScreenChord(try event(.command, characters: "K"))
        )
        XCTAssertFalse(
            QmuxTerminalView.isClearScreenChord(try event([.command, .shift], characters: "K"))
        )
        XCTAssertFalse(
            QmuxTerminalView.isClearScreenChord(try event(.command, characters: "j"))
        )
    }

    func testStaleSettingsCannotReplaceNewerTheme() async throws {
        do {
            let pane = NativeTerminalPane(
                paneID: "native-settings-revision-test-pane",
                workingDirectory: nil,
                themeName: QmuxTerminalTheme.defaultName
            )
            var newer = Self.settings
            newer.revision = 2
            newer.themeName = "Cursor Dark"
            XCTAssertTrue(pane.applySettings(newer))

            var stale = Self.settings
            stale.revision = 1
            XCTAssertTrue(pane.applySettings(stale))

            XCTAssertEqual(
                pane.controller.theme,
                QmuxTerminalTheme.theme(named: "Cursor Dark")
            )
        }
    }

    func testUnchangedTabRevealDoesNotEmitResizeOrMoveViewport() async throws {
        do {
            try await Self.withPane { paneID, frame in
                let session = try XCTUnwrap(
                    TerminalSessionRegistry.shared.session(for: paneID)
                )
                session.receive(
                    (0..<120)
                        .map { String(format: "line-%03d", $0) }
                        .joined(separator: "\r\n")
                )
                XCTAssertTrue(
                    NativeTerminalHost.shared.performAction(
                        id: paneID,
                        action: "scroll_to_top"
                    )
                )
                await Self.waitForPtyResizeFlush()
                let viewportBefore = try XCTUnwrap(session.readViewportText())
                XCTAssertTrue(viewportBefore.contains("line-000"))

                NativeTerminalCallbackRecorder.shared.reset()
                XCTAssertTrue(
                    Self.setLayout(paneID: paneID, frame: frame, visible: false)
                )
                XCTAssertTrue(
                    Self.setLayout(paneID: paneID, frame: frame, visible: true)
                )
                await Self.waitForPtyResizeFlush()

                XCTAssertTrue(NativeTerminalCallbackRecorder.shared.resizes.isEmpty)
                XCTAssertEqual(session.readViewportText(), viewportBefore)
            }
        }
    }

    func testSplitResizePreservesScrolledViewport() async throws {
        do {
            try await Self.withPane { paneID, frame in
                let session = try XCTUnwrap(TerminalSessionRegistry.shared.session(for: paneID))
                session.receive((0..<120).map { String(format: "line-%03d", $0) }.joined(separator: "\r\n"))
                await Self.waitForPtyResizeFlush()
                XCTAssertTrue(NativeTerminalHost.shared.performAction(id: paneID, action: "scroll_to_top"))
                await Self.waitForPtyResizeFlush()
                let before = try XCTUnwrap(session.readViewportText())
                XCTAssertTrue(before.hasPrefix("line-000"), before)
                let smaller = CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height / 2)
                XCTAssertTrue(Self.setLayout(paneID: paneID, frame: smaller, visible: true))
                await Self.waitForPtyResizeFlush()
                XCTAssertTrue(try XCTUnwrap(session.readViewportText()).hasPrefix("line-000"))
            }
        }
    }

    func testSplitResizeKeepsShortShellOutputVisible() async throws {
        do {
            try await Self.withPane { paneID, frame in
                let session = try XCTUnwrap(TerminalSessionRegistry.shared.session(for: paneID))
                session.receive("first line\r\nsecond line\r\nprompt> ")
                let smaller = CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height / 2)
                XCTAssertTrue(Self.setLayout(paneID: paneID, frame: smaller, visible: true))
                await Self.waitForPtyResizeFlush()
                let text = try XCTUnwrap(session.readViewportText())
                XCTAssertTrue(text.contains("first line"), text)
                XCTAssertTrue(text.contains("prompt>"), text)
            }
        }
    }

    func testViewGridNotificationDoesNotResizePty() async {
        let pane = NativeTerminalPane(
            paneID: "view-grid-notification-test",
            workingDirectory: nil,
            themeName: QmuxTerminalTheme.defaultName
        )
        NativeTerminalCallbackRecorder.shared.reset()
        pane.terminalDidResize(columns: 40, rows: 12)
        await Self.waitForPtyResizeFlush()
        XCTAssertTrue(NativeTerminalCallbackRecorder.shared.resizes.isEmpty)
    }

    func testPrimaryScreenPagerRepaintAfterResize() async throws {
        try await Self.withPane { paneID, frame in
            let session = try XCTUnwrap(TerminalSessionRegistry.shared.session(for: paneID))
            session.receive((0..<80).map { "old-\($0)" }.joined(separator: "\r\n"))
            NativeTerminalCallbackRecorder.shared.reset()
            let smaller = CGRect(
                x: frame.minX, y: frame.minY,
                width: frame.width / 2, height: frame.height / 2
            )
            XCTAssertTrue(Self.setLayout(paneID: paneID, frame: smaller, visible: true))
            // Repaint as soon as the PTY is notified, just as less -X does on
            // SIGWINCH. Polling has a deadline, not a guessed IO resize delay.
            let deadline = ContinuousClock.now + .seconds(2)
            while NativeTerminalCallbackRecorder.shared.resizes.isEmpty,
                  ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(1))
            }
            let resize = try XCTUnwrap(NativeTerminalCallbackRecorder.shared.resizes.last)
            let repaint = "\u{1b}[H\u{1b}[2J" + (0..<Int(resize.rows)).map {
                "new-\($0) " + String(repeating: "x", count: max(0, Int(resize.columns) - 10))
            }.joined(separator: "\r\n")
            session.receive(repaint)
            await Self.waitForPtyResizeFlush()
            let settled = try XCTUnwrap(session.readViewportText())
            XCTAssertTrue(settled.hasPrefix("new-0"), settled)
            XCTAssertTrue(settled.contains("new-\(resize.rows - 1)"), settled)
        }
    }

    func testRealFrameChangeStillEmitsResize() async throws {
        do {
            try await Self.withPane { paneID, frame in
                NativeTerminalCallbackRecorder.shared.reset()
                let widerFrame = CGRect(
                    x: frame.minX,
                    y: frame.minY,
                    width: frame.width + 180,
                    height: frame.height
                )

                XCTAssertTrue(
                    Self.setLayout(paneID: paneID, frame: frame, visible: false)
                )
                XCTAssertTrue(
                    Self.setLayout(
                        paneID: paneID,
                        frame: widerFrame,
                        visible: true
                    )
                )
                await Self.waitForPtyResizeFlush()

                let resizes = NativeTerminalCallbackRecorder.shared.resizes
                XCTAssertEqual(resizes.count, 1)
                let resize = try XCTUnwrap(resizes.first)
                XCTAssertGreaterThan(resize.columns, 0)
                XCTAssertGreaterThan(resize.rows, 0)
            }
        }
    }

    func testRapidFrameChangesCoalesceToOnePtyResize() async throws {
        do {
            try await Self.withPane { paneID, frame in
                NativeTerminalCallbackRecorder.shared.reset()
                let mid = CGRect(
                    x: frame.minX,
                    y: frame.minY,
                    width: frame.width,
                    height: frame.height + 80
                )
                let tall = CGRect(
                    x: frame.minX,
                    y: frame.minY,
                    width: frame.width,
                    height: frame.height + 200
                )
                XCTAssertTrue(Self.setLayout(paneID: paneID, frame: mid, visible: true))
                XCTAssertTrue(Self.setLayout(paneID: paneID, frame: tall, visible: true))
                XCTAssertTrue(
                    NativeTerminalCallbackRecorder.shared.resizes.isEmpty,
                    "TIOCSWINSZ must wait until after Ghostty's present"
                )
                await Self.waitForPtyResizeFlush()
                let resizes = NativeTerminalCallbackRecorder.shared.resizes
                XCTAssertEqual(resizes.count, 1)
                XCTAssertGreaterThan(try XCTUnwrap(resizes.first).rows, 0)
            }
        }
    }

    func testRemovedPaneDoesNotFlushPtyResize() async throws {
        do {
            try await Self.withPane { paneID, frame in
                NativeTerminalCallbackRecorder.shared.reset()
                let taller = CGRect(
                    x: frame.minX,
                    y: frame.minY,
                    width: frame.width,
                    height: frame.height + 160
                )
                XCTAssertTrue(Self.setLayout(paneID: paneID, frame: taller, visible: true))
                NativeTerminalHost.shared.removePane(id: paneID)
                await Self.waitForPtyResizeFlush()
                XCTAssertTrue(NativeTerminalCallbackRecorder.shared.resizes.isEmpty)
            }
        }
    }

    func testKeyboardFocusReturnsAfterGeometryDragBlockerClears() async throws {
        do {
            let paneID = "native-resize-focus-test-pane"
            let frame = CGRect(x: 24, y: 18, width: 720, height: 360)
            NativeTerminalHost.shared.shutdown()
            NativeTerminalCallbackRecorder.shared.reset()
            Self.layoutRevisionCounter = 0
            let root = NSView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800))
            let window = NSWindow(
                contentRect: root.bounds,
                styleMask: [.borderless],
                backing: .buffered,
                defer: false
            )
            window.contentView = root
            defer {
                NativeTerminalHost.shared.shutdown()
                NativeTerminalCallbackRecorder.shared.reset()
                window.close()
                withExtendedLifetime(root) {}
            }

            XCTAssertTrue(NativeTerminalHost.shared.attach(to: root))
            NativeTerminalHost.shared.seedSettings(Self.settings)
            XCTAssertTrue(
                NativeTerminalHost.shared.createPane(
                    id: paneID,
                    workingDirectory: nil
                )
            )
            XCTAssertTrue(Self.setLayout(paneID: paneID, frame: frame, visible: true))
            let terminalView = try XCTUnwrap(Self.terminalView(in: root))

            // A split drag enters the shared input-blocked state, releasing
            // the native owner while WebKit handles the gesture. Clearing the
            // blocker must make the same active pane first responder again.
            XCTAssertTrue(
                NativeTerminalHost.shared.setDesiredKeyboardOwner(
                    id: paneID,
                    revision: 1
                )
            )
            XCTAssertTrue(window.firstResponder === terminalView)
            XCTAssertTrue(
                NativeTerminalHost.shared.setDesiredKeyboardOwner(
                    id: nil,
                    revision: 2
                )
            )
            XCTAssertTrue(
                NativeTerminalHost.shared.setLayout(
                    id: paneID,
                    frame: frame,
                    visible: true,
                    acceptsPointerInput: false,
                    acceptsKeyboardClaim: false,
                    deferGeometry: true,
                    revision: Self.nextLayoutRevision()
                )
            )
            XCTAssertTrue(Self.setLayout(paneID: paneID, frame: frame, visible: true))
            XCTAssertTrue(
                NativeTerminalHost.shared.setDesiredKeyboardOwner(
                    id: paneID,
                    revision: 3
                )
            )
            XCTAssertTrue(window.firstResponder === terminalView)
        }
    }

    func testStaleLayoutRevisionDoesNotOverwriteNewerFrame() async throws {
        do {
            try await Self.withPane { paneID, frame in
                let wider = CGRect(
                    x: frame.minX,
                    y: frame.minY,
                    width: frame.width + 200,
                    height: frame.height
                )
                let newerRevision = Self.nextLayoutRevision()
                let olderRevision = newerRevision - 1
                XCTAssertTrue(
                    NativeTerminalHost.shared.setLayout(
                        id: paneID,
                        frame: wider,
                        visible: true,
                        acceptsPointerInput: true,
                        acceptsKeyboardClaim: true,
                        deferGeometry: false,
                        revision: newerRevision
                    )
                )
                await Self.waitForPtyResizeFlush()
                NativeTerminalCallbackRecorder.shared.reset()
                // An older revision carrying the previous, smaller frame must
                // be ignored even though it arrives later on the main actor.
                XCTAssertTrue(
                    NativeTerminalHost.shared.setLayout(
                        id: paneID,
                        frame: frame,
                        visible: true,
                        acceptsPointerInput: true,
                        acceptsKeyboardClaim: true,
                        deferGeometry: false,
                        revision: olderRevision
                    )
                )
                await Self.waitForPtyResizeFlush()
                XCTAssertTrue(NativeTerminalCallbackRecorder.shared.resizes.isEmpty)

                // Re-applying the wider frame under a fresh revision must also
                // be a no-op: the stale path did not shrink the surface.
                NativeTerminalCallbackRecorder.shared.reset()
                XCTAssertTrue(
                    NativeTerminalHost.shared.setLayout(
                        id: paneID,
                        frame: wider,
                        visible: true,
                        acceptsPointerInput: true,
                        acceptsKeyboardClaim: true,
                        deferGeometry: false,
                        revision: Self.nextLayoutRevision()
                    )
                )
                await Self.waitForPtyResizeFlush()
                XCTAssertTrue(NativeTerminalCallbackRecorder.shared.resizes.isEmpty)
            }
        }
    }

    func testWebViewReloadClearsOldDocumentLayoutRevisions() async throws {
        do {
            try await Self.withPane { paneID, frame in
                let wider = CGRect(
                    x: frame.minX,
                    y: frame.minY,
                    width: frame.width + 180,
                    height: frame.height
                )
                XCTAssertTrue(
                    NativeTerminalHost.shared.setLayout(
                        id: paneID,
                        frame: frame,
                        visible: true,
                        acceptsPointerInput: true,
                        acceptsKeyboardClaim: true,
                        deferGeometry: false,
                        revision: 50_000
                    )
                )
                XCTAssertTrue(NativeTerminalHost.shared.prepareForWebViewReload())

                NativeTerminalCallbackRecorder.shared.reset()
                XCTAssertTrue(
                    NativeTerminalHost.shared.setLayout(
                        id: paneID,
                        frame: wider,
                        visible: true,
                        acceptsPointerInput: true,
                        acceptsKeyboardClaim: true,
                        deferGeometry: false,
                        revision: 1
                    )
                )
                await Self.waitForPtyResizeFlush()
                XCTAssertEqual(NativeTerminalCallbackRecorder.shared.resizes.count, 1)
            }
        }
    }

    @MainActor
    private static func waitForPtyResizeFlush() async {
        // Ghostty coalesces IO resizes on its own timer, independently of the
        // AppKit main queue. Include that work when settling layout tests.
        try? await Task.sleep(for: .milliseconds(100))
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async {
                DispatchQueue.main.async {
                    DispatchQueue.main.async {
                        continuation.resume()
                    }
                }
            }
        }
    }

    @MainActor
    private static func withPane(
        _ body: (_ paneID: String, _ frame: CGRect) async throws -> Void
    ) async rethrows {
        let paneID = "native-layout-test-pane"
        let frame = CGRect(x: 24, y: 18, width: 720, height: 360)
        NativeTerminalHost.shared.shutdown()
        NativeTerminalCallbackRecorder.shared.reset()
        layoutRevisionCounter = 0
        let root = NSView(frame: CGRect(x: 0, y: 0, width: 1200, height: 800))
        let window = NSWindow(contentRect: root.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = root
        XCTAssertTrue(NativeTerminalHost.shared.attach(to: root))
        NativeTerminalHost.shared.seedSettings(Self.settings)
        XCTAssertTrue(
            NativeTerminalHost.shared.createPane(
                id: paneID,
                workingDirectory: nil
            )
        )
        XCTAssertTrue(Self.setLayout(paneID: paneID, frame: frame, visible: true))
        XCTAssertTrue(NativeTerminalHost.shared.paneIsReadyForReplay(id: paneID))
        await waitForPtyResizeFlush()
        NativeTerminalCallbackRecorder.shared.reset()
        defer {
            NativeTerminalHost.shared.shutdown()
            NativeTerminalCallbackRecorder.shared.reset()
            withExtendedLifetime((root, window)) {}
        }
        try await body(paneID, frame)
    }

    @MainActor
    private static var layoutRevisionCounter: UInt64 = 0

    @MainActor
    private static func nextLayoutRevision() -> UInt64 {
        layoutRevisionCounter += 1
        return layoutRevisionCounter
    }

    @MainActor
    private static func setLayout(
        paneID: String,
        frame: CGRect,
        visible: Bool
    ) -> Bool {
        NativeTerminalHost.shared.setLayout(
            id: paneID,
            frame: frame,
            visible: visible,
            acceptsPointerInput: visible,
            acceptsKeyboardClaim: true,
            deferGeometry: false,
            revision: nextLayoutRevision()
        )
    }

    @MainActor
    private static func terminalView(in root: NSView) -> QmuxTerminalView? {
        if let terminal = root as? QmuxTerminalView {
            return terminal
        }
        for child in root.subviews {
            if let terminal = terminalView(in: child) {
                return terminal
            }
        }
        return nil
    }

    private static let settings = TerminalPaneSettings(
        revision: 1,
        fontSize: 13,
        fontFamily: "Menlo",
        letterSpacing: 0,
        lineHeight: 1.2,
        cursorBlink: false,
        cursorStyle: "block",
        scrollbackRows: 10_000,
        scrollOnUserInput: true,
        scrollSensitivity: 1,
        copyOnSelect: false,
        selectionClearOnCopy: false,
        themeName: QmuxTerminalTheme.defaultName
    )
}
