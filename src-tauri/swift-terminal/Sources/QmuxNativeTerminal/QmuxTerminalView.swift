import AppKit
import GhosttyTerminal

/// qmux-specific native menu actions that must live in AppKit rather than in a
/// transparent React overlay above the Metal-backed terminal surface.
final class QmuxTerminalView: TerminalView {
    var onPasteRequest: (() -> Void)?

    override func paste(_: Any?) {
        onPasteRequest?()
    }
}
