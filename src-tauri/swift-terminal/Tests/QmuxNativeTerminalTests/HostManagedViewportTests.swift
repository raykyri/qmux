@testable import GhosttyTerminal
import Testing
import Foundation

@MainActor
struct HostManagedViewportTests {
    @Test
    func `view metrics do not publish a premature backend resize`() {
        let received = ResizeRecorder()
        let session = InMemoryTerminalSession(write: { _ in }, resize: { received.append($0) })
        session.updateViewport(TerminalGridMetrics(
            columns: 40, rows: 12, widthPixels: 640, heightPixels: 384,
            cellWidthPixels: 16, cellHeightPixels: 32
        ))
        #expect(received.values.isEmpty)

        let userdata = Unmanaged.passUnretained(session).toOpaque()
        InMemoryTerminalSession.receiveResizeCallback(userdata, 40, 12, 640, 384)
        #expect(received.values == [InMemoryTerminalViewport(
            columns: 40, rows: 12, widthPixels: 640, heightPixels: 384,
            cellWidthPixels: 16, cellHeightPixels: 32
        )])
        InMemoryTerminalSession.receiveResizeCallback(userdata, 40, 12, 640, 384)
        #expect(received.values.count == 1)
    }

    /// `readViewportText()` MUST return `nil` (not crash) when no surface is
    /// attached. This is the canonical pre-surface / post-surface-teardown
    /// state — consumers may call `readViewportText` from any thread that
    /// holds a reference, and the contract is "nil means no surface."
    @Test
    func `read viewport text returns nil before surface attached`() {
        let session = InMemoryTerminalSession(write: { _ in }, resize: { _ in })
        #expect(session.readViewportText() == nil)
    }

    /// After clearing the surface, the read MUST go back to returning `nil`.
    /// Together with the test above this pins the surface-presence semantics
    /// of the public API.
    @Test
    func `read viewport text returns nil after surface cleared`() {
        let session = InMemoryTerminalSession(write: { _ in }, resize: { _ in })
        session.clearSurface(ifMatches: nil)
        #expect(session.readViewportText() == nil)
    }
}

private final class ResizeRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [InMemoryTerminalViewport] = []

    func append(_ value: InMemoryTerminalViewport) {
        lock.lock()
        defer { lock.unlock() }
        storage.append(value)
    }

    var values: [InMemoryTerminalViewport] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}
