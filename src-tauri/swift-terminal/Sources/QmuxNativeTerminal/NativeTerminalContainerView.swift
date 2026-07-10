import AppKit

@MainActor
final class NativeTerminalContainerView: NSView {
    var onLiveResizeChange: ((Bool) -> Void)?

    override var isFlipped: Bool {
        true
    }

    override func viewWillStartLiveResize() {
        super.viewWillStartLiveResize()
        onLiveResizeChange?(true)
    }

    override func viewDidEndLiveResize() {
        super.viewDidEndLiveResize()
        onLiveResizeChange?(false)
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        // WKWebView remains the window's hit-test surface. A native event monitor
        // routes events in registered terminal rectangles to the views below it.
        nil
    }
}
