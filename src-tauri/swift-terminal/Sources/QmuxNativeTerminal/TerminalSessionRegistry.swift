import Foundation
import GhosttyTerminal

/// Thread-safe pane-id → terminal-session lookup for the PTY output path.
///
/// PTY bytes arrive on Rust reader threads once per chunk, and routing every
/// chunk through `DispatchQueue.main.sync` just to look the session up in
/// `NativeTerminalHost.panes` made the main thread a rendezvous point for all
/// pane output: any long main-thread work (layout bursts, menu tracking,
/// window resize) stalled every terminal's throughput. The host registers each
/// pane's session at creation and unregisters it on removal, so the receive
/// path resolves the session under a plain lock instead of hopping threads.
/// The session itself already accepted bytes off-main — the old hop covered
/// only the dictionary lookup.
final class TerminalSessionRegistry: @unchecked Sendable {
    static let shared = TerminalSessionRegistry()

    private let lock = NSLock()
    private var sessions: [String: InMemoryTerminalSession] = [:]

    func register(_ session: InMemoryTerminalSession, for paneID: String) {
        lock.lock()
        defer { lock.unlock() }
        sessions[paneID] = session
    }

    func unregister(_ paneID: String) {
        lock.lock()
        defer { lock.unlock() }
        sessions.removeValue(forKey: paneID)
    }

    func unregisterAll() {
        lock.lock()
        defer { lock.unlock() }
        sessions.removeAll()
    }

    func session(for paneID: String) -> InMemoryTerminalSession? {
        lock.lock()
        defer { lock.unlock() }
        return sessions[paneID]
    }
}
