import Foundation
import GhosttyKit
import Testing
@testable import GhosttyTerminal
@testable import QmuxNativeTerminal

struct TerminalOutputContextTests {
    @Test @MainActor
    func `main thread teardown drains the app while parsing is active`() {
        let started = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let ticks = OutputObservations()
        let access = InMemoryTerminalSurfaceAccess(
            write: { _, _ in
                started.signal()
                _ = release.wait(timeout: .now() + 5)
            },
            processExit: { _, _, _ in },
            tick: { _ in
                ticks.append("tick", generation: 0)
                release.signal()
            }
        )
        let surface = UnsafeMutableRawPointer(bitPattern: 2)!
        access.setSurface(surface)
        let accepted = access.enqueueWrite(Data("busy".utf8), beforeWrite: {}, afterWrite: {})
        #expect(accepted)
        #expect(started.wait(timeout: .now() + 5) == .success)
        access.clearSurface(ifMatches: surface)
        #expect(!ticks.values.isEmpty)
        #expect(access.currentSurface == nil)
    }

    @Test
    func `queued output scopes annotation mutations to actual parsing`() {
        let paneID = "output-context-\(UUID().uuidString)"
        let registry = TerminalAnnotationContentRegistry.shared
        let started = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let observations = OutputObservations()
        let session = InMemoryTerminalSession(
            write: { _ in }, resize: { _ in },
            surfaceWrite: { _, data in
                let text = String(decoding: data, as: UTF8.self)
                if text == "block" {
                    started.signal()
                    _ = release.wait(timeout: .now() + 5)
                } else {
                    observations.append(
                        text,
                        generation: registry.generation(for: paneID)
                    )
                }
            }
        )
        session.setSurface(UnsafeMutableRawPointer(bitPattern: 1)!)
        defer { registry.remove(paneID) }
        session.receive(Data("block".utf8))
        #expect(started.wait(timeout: .now() + 5) == .success)
        #expect(TerminalOutputContext.receive(
            Data("history".utf8), session: session, paneID: paneID
        ))
        #expect(TerminalOutputContext.receive(
            Data("live".utf8), session: session, paneID: paneID
        ))
        #expect(registry.generation(for: paneID) == 0)
        release.signal()
        session.waitForPendingOutput()
        #expect(observations.values == [
            .init(text: "history", generation: 1),
            .init(text: "live", generation: 3),
        ])
        #expect(registry.generation(for: paneID) == 4)
    }

    @Test
    func `rejected output leaves content generations untouched`() {
        let paneID = "missing-output-\(UUID().uuidString)"
        let parsed = OutputObservations()
        let session = InMemoryTerminalSession(
            write: { _ in }, resize: { _ in },
            surfaceWrite: { _, data in
                parsed.append(String(decoding: data, as: UTF8.self), generation: 0)
            }
        )
        #expect(!TerminalOutputContext.receive(
            Data("history".utf8), session: session, paneID: paneID
        ))
        // Rust retains rejected history for retry. It must not also be
        // buffered by the new upstream session and replayed twice on attach.
        session.setSurface(UnsafeMutableRawPointer(bitPattern: 3)!)
        session.waitForPendingOutput()
        #expect(parsed.values.isEmpty)
        #expect(TerminalAnnotationContentRegistry.shared.generation(for: paneID) == 0)
    }
}

private final class OutputObservations: @unchecked Sendable {
    struct Value: Equatable {
        let text: String
        let generation: UInt64
    }
    private let lock = NSLock()
    private var storage: [Value] = []

    func append(_ text: String, generation: UInt64) {
        lock.lock()
        defer { lock.unlock() }
        storage.append(Value(text: text, generation: generation))
    }

    var values: [Value] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}
