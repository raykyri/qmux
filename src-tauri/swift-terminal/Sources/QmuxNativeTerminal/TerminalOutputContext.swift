import Foundation
import GhosttyTerminal

/// Annotation generations follow a chunk onto the session's output queue,
/// remaining odd for exactly the duration of its parse.
enum TerminalOutputContext {
    @discardableResult
    static func receive(
        _ data: Data,
        session: InMemoryTerminalSession,
        paneID: String
    ) -> Bool {
        session.receive(data, beforeWrite: {
            TerminalAnnotationContentRegistry.shared.beginContentMutation(for: paneID)
        }, afterWrite: {
            TerminalAnnotationContentRegistry.shared.endContentMutation(for: paneID)
        })
    }
}
