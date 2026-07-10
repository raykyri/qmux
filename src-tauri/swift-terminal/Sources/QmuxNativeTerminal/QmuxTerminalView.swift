import AppKit
import GhosttyTerminal

/// qmux-specific native menu actions that must live in AppKit rather than in a
/// transparent React overlay above the Metal-backed terminal surface.
final class QmuxTerminalView: TerminalView {
    var canAskSelection = false
    var onAskSelection: (() -> Void)?
    var onPasteRequest: (() -> Void)?

    override func selectionContextMenu() -> NSMenu {
        let menu = super.selectionContextMenu()
        guard canAskSelection, onAskSelection != nil else { return menu }
        menu.addItem(.separator())
        let askItem = NSMenuItem(
            title: "Ask agent about selection",
            action: #selector(askAboutSelection(_:)),
            keyEquivalent: ""
        )
        askItem.target = self
        menu.addItem(askItem)
        return menu
    }

    @objc private func askAboutSelection(_: Any?) {
        onAskSelection?()
    }

    override func paste(_: Any?) {
        onPasteRequest?()
    }
}
