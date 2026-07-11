@preconcurrency import AppKit
import GhosttyTerminal
import WebKit

@MainActor
final class NativeTerminalHost {
    static let shared = NativeTerminalHost()

    private(set) var container: NativeTerminalContainerView?
    private var panes: [String: NativeTerminalPane] = [:]
    private var backstop: NSView?
    private var eventMonitor: Any?
    private weak var keyboardOwnerPane: NativeTerminalPane?
    private weak var pointerCapturePane: NativeTerminalPane?
    private var webPointerRoutingClaimed = false
    /// When true, the next pointer-up clears `webPointerRoutingClaimed`. Used for
    /// mid-gesture drag claims (button already down when claimed). Sticky claims
    /// such as open sidebar menus start with buttons up and stay until explicit release.
    private var webPointerClaimClearsOnPointerUp = false
    /// DOM rectangles (webview CSS coordinates, matching the flipped container)
    /// that own pointer events even where they overlap a terminal surface —
    /// small controls floating over the terminal, like the right-bar restore
    /// button. Unlike a web pointer claim, the rest of the terminal stays live.
    private var webOverlayRegions: [String: CGRect] = [:]
    private var windowLiveResizeActive = false
    private var clientDeferredGeometryPaneIDs: Set<String> = []
    private var pendingPaneFrames: [String: CGRect] = [:]
    private var pendingFitPaneIDs: Set<String> = []
    /// The theme every pane currently uses. Settings arrive per pane, but the
    /// frontend sends one theme for all of them; new panes and the stage
    /// backstop read this instead of waiting for their first settings update.
    private var currentThemeName = QmuxTerminalTheme.defaultName

    private init() {}

    /// Resolved live rather than captured at attach time: attach can run before
    /// the supplied view tree is windowed, and a stale/nil reference here would
    /// silently disable first-responder handoff and all key/pointer routing
    /// while leaving rendering intact.
    private var window: NSWindow? {
        container?.window
    }

    func attach(to suppliedView: NSView) -> Bool {
        if container != nil {
            return true
        }

        let webView = findWebView(in: suppliedView)
        let parent = webView?.superview ?? suppliedView
        let container = NativeTerminalContainerView(
            frame: webView?.frame ?? parent.bounds
        )
        // Always track the parent's size ourselves. A constraint-managed
        // WKWebView reports an empty autoresizingMask, and copying that would
        // freeze the container's bounds on window resize while pointer
        // hit-testing keeps converting window coordinates through them.
        container.autoresizingMask = [.width, .height]
        container.onLiveResizeChange = { [weak self] active in
            self?.setWindowLiveResizeActive(active)
        }
        parent.addSubview(container, positioned: .below, relativeTo: webView)

        self.container = container
        installEventMonitor()
        return true
    }

    /// Keeps an opaque terminal-colored view under the webview's terminal stage
    /// rectangle, below every pane surface. The webview's stage pixels are fully
    /// transparent while panes are shown, and pane surfaces chase their DOM rects
    /// asynchronously (rAF + IPC + layout), so without this any transient gap —
    /// pane spawn, Home→pane switches, split-resize lag — would expose the
    /// window's vibrancy material instead of terminal-colored pixels.
    func setStageBackstop(frame: CGRect) -> Bool {
        guard let container else { return false }
        let view: NSView
        if let backstop {
            view = backstop
        } else {
            let created = NSView(frame: frame)
            created.wantsLayer = true
            created.layer?.backgroundColor = QmuxTerminalTheme.backgroundColor(
                named: currentThemeName
            )
            container.addSubview(created, positioned: .below, relativeTo: nil)
            backstop = created
            view = created
        }
        if view.frame != frame {
            view.frame = frame
        }
        return true
    }

    func createPane(
        id: String,
        launcherPath: String,
        workingDirectory: String?
    ) -> Bool {
        guard let container else { return false }
        if panes[id] != nil {
            return true
        }

        let pane = NativeTerminalPane(
            paneID: id,
            launcherPath: launcherPath,
            workingDirectory: workingDirectory,
            themeName: currentThemeName
        )
        pane.view.isHidden = true
        pane.view.setSurfaceVisible(false)
        container.addSubview(pane.view)
        panes[id] = pane
        return true
    }

    func removePane(id: String) {
        guard let pane = panes.removeValue(forKey: id) else { return }
        if keyboardOwnerPane === pane {
            setKeyboardOwner(nil)
        }
        if pointerCapturePane === pane {
            pointerCapturePane = nil
        }
        clientDeferredGeometryPaneIDs.remove(id)
        pendingPaneFrames.removeValue(forKey: id)
        pendingFitPaneIDs.remove(id)
        pane.view.removeFromSuperview()
    }

    func terminatePane(id: String) -> Bool {
        guard let pane = panes[id] else { return false }
        return pane.view.performBindingAction("close_surface")
    }

    func surfaceDidClose(id: String) {
        DispatchQueue.main.async { [weak self] in
            self?.removePane(id: id)
        }
    }

    func setLayout(
        id: String,
        frame: CGRect,
        visible: Bool,
        focused: Bool,
        acceptsPointerInput: Bool,
        acceptsKeyboardInput: Bool,
        deferGeometry: Bool
    ) -> Bool {
        guard let pane = panes[id] else { return false }
        pane.acceptsPointerInput = acceptsPointerInput
        pane.acceptsKeyboardInput = acceptsKeyboardInput
        if !acceptsPointerInput, pointerCapturePane === pane {
            pointerCapturePane = nil
        }
        let visibilityChanged = pane.view.isHidden != !visible
        if visibilityChanged {
            pane.view.isHidden = !visible
            pane.view.setSurfaceVisible(visible)
        }

        if deferGeometry {
            clientDeferredGeometryPaneIDs.insert(id)
        } else {
            clientDeferredGeometryPaneIDs.remove(id)
        }
        let shouldDeferGeometry =
            deferGeometry
            || windowLiveResizeActive
            || container?.inLiveResize == true
        if shouldDeferGeometry {
            pendingPaneFrames[id] = frame
            if visible, visibilityChanged {
                pendingFitPaneIDs.insert(id)
            }
        } else {
            pendingPaneFrames.removeValue(forKey: id)
            let needsDeferredFit = pendingFitPaneIDs.remove(id) != nil
            applyGeometry(
                frame,
                to: pane,
                forceFit: visibilityChanged || needsDeferredFit
            )
        }
        let shouldOwnKeyboard = focused && visible && acceptsKeyboardInput
        if shouldOwnKeyboard {
            setKeyboardOwner(pane)
        } else {
            pane.isFocused = false
            if keyboardOwnerPane === pane {
                setKeyboardOwner(nil)
            }
        }
        return true
    }

    private func setWindowLiveResizeActive(_ active: Bool) {
        windowLiveResizeActive = active
        if !active {
            flushPendingGeometry()
        }
    }

    private func flushPendingGeometry() {
        let paneIDs = pendingPaneFrames.keys.filter {
            !clientDeferredGeometryPaneIDs.contains($0)
        }
        for paneID in paneIDs {
            guard let frame = pendingPaneFrames.removeValue(forKey: paneID),
                  let pane = panes[paneID]
            else { continue }
            let needsDeferredFit = pendingFitPaneIDs.remove(paneID) != nil
            applyGeometry(frame, to: pane, forceFit: needsDeferredFit)
        }
    }

    /// Assigning a TerminalView frame and fitting it recomputes Ghostty's grid,
    /// which resizes the PTY. Keep that work out of live resize loops.
    private func applyGeometry(
        _ frame: CGRect,
        to pane: NativeTerminalPane,
        forceFit: Bool
    ) {
        let frameChanged = pane.view.frame != frame
        if frameChanged {
            pane.view.frame = frame
        }
        if !pane.view.isHidden, frameChanged || forceFit {
            pane.view.fitToSize()
        }
    }

    func focusPane(id: String) -> Bool {
        guard let pane = panes[id],
              !pane.view.isHidden,
              pane.acceptsKeyboardInput
        else { return false }
        return setKeyboardOwner(pane)
    }

    func setWebPointerRoutingClaimed(_ claimed: Bool) -> Bool {
        guard container != nil else { return false }
        webPointerRoutingClaimed = claimed
        if claimed {
            // A left-down over a web overlay is initially visible to both the
            // native monitor and WKWebView. Relinquish any optimistic Ghostty
            // capture once React identifies that gesture as a web drag.
            pointerCapturePane = nil
            // Drag claims arrive while a button is still down and should end with
            // that gesture. Menu/overlay claims arrive between gestures and must
            // survive subsequent clicks until the frontend releases them.
            webPointerClaimClearsOnPointerUp = NSEvent.pressedMouseButtons != 0
        } else {
            webPointerClaimClearsOnPointerUp = false
        }
        return true
    }

    func setWebOverlayRegion(id: String, frame: CGRect?) -> Bool {
        guard container != nil else { return false }
        if let frame {
            webOverlayRegions[id] = frame
        } else {
            webOverlayRegions.removeValue(forKey: id)
        }
        return true
    }

    func sendText(id: String, text: String) -> Bool {
        guard let pane = panes[id] else { return false }
        // Report a dead/not-yet-created surface as failure: the surface only
        // exists after the frontend's first settings round-trip, and Rust
        // callers record successful writes as delivered turns.
        return pane.view.sendText(text)
    }

    func submit(id: String) -> Bool {
        guard let pane = panes[id], pane.view.isSurfaceLive, let window else { return false }
        let timestamp = ProcessInfo.processInfo.systemUptime
        let makeEvent = { (type: NSEvent.EventType) in
            NSEvent.keyEvent(
                with: type,
                location: .zero,
                modifierFlags: [],
                timestamp: timestamp,
                windowNumber: window.windowNumber,
                context: nil,
                characters: "\r",
                charactersIgnoringModifiers: "\r",
                isARepeat: false,
                keyCode: 0x24
            )
        }
        guard let keyDown = makeEvent(.keyDown),
              let keyUp = makeEvent(.keyUp)
        else { return false }
        pane.view.keyDown(with: keyDown)
        pane.view.keyUp(with: keyUp)
        return true
    }

    func pasteApprovedText(id: String, text: String) -> Bool {
        guard let pane = panes[id] else { return false }
        return pane.pasteApprovedText(text)
    }

    func performAction(id: String, action: String) -> Bool {
        guard let pane = panes[id] else { return false }
        return pane.view.performBindingAction(action)
    }

    func updateSettings(
        id: String,
        fontSize: Double,
        fontFamily: String,
        letterSpacing: Double,
        lineHeight: Double,
        cursorBlink: Bool,
        cursorStyle: String,
        scrollbackRows: UInt32,
        scrollOnUserInput: Bool,
        scrollSensitivity: Double,
        copyOnSelect: Bool,
        selectionClearOnCopy: Bool,
        themeName: String
    ) -> Bool {
        guard let pane = panes[id] else { return false }
        if themeName != currentThemeName {
            currentThemeName = themeName
            backstop?.layer?.backgroundColor = QmuxTerminalTheme.backgroundColor(
                named: themeName
            )
        }
        return pane.updateSettings(
            fontSize: fontSize,
            fontFamily: fontFamily,
            letterSpacing: letterSpacing,
            lineHeight: lineHeight,
            cursorBlink: cursorBlink,
            cursorStyle: cursorStyle,
            scrollbackRows: scrollbackRows,
            scrollOnUserInput: scrollOnUserInput,
            scrollSensitivity: scrollSensitivity,
            copyOnSelect: copyOnSelect,
            selectionClearOnCopy: selectionClearOnCopy,
            themeName: themeName
        )
    }

    func shutdown() {
        if let eventMonitor {
            NSEvent.removeMonitor(eventMonitor)
            self.eventMonitor = nil
        }
        setKeyboardOwner(nil)
        pointerCapturePane = nil
        webPointerRoutingClaimed = false
        webPointerClaimClearsOnPointerUp = false
        webOverlayRegions.removeAll()
        for pane in panes.values {
            pane.view.removeFromSuperview()
        }
        panes.removeAll()
        clientDeferredGeometryPaneIDs.removeAll()
        pendingPaneFrames.removeAll()
        pendingFitPaneIDs.removeAll()
        windowLiveResizeActive = false
        backstop?.removeFromSuperview()
        backstop = nil
        container?.onLiveResizeChange = nil
        container?.removeFromSuperview()
        container = nil
    }

    /// The React layout is the authority for normal ownership changes, while a
    /// pointer-down can claim a pane optimistically until that layout arrives.
    /// Keeping one explicit owner avoids inferring intent from AppKit's current
    /// first responder, which WKWebView may replace during unrelated focus churn.
    @discardableResult
    private func setKeyboardOwner(_ pane: NativeTerminalPane?) -> Bool {
        let previous = keyboardOwnerPane
        if previous !== pane {
            previous?.isFocused = false
            previous?.consumedShortcutKeyCodes.removeAll()
            keyboardOwnerPane = pane
            if pane == nil {
                previous?.reportCommandModifier(active: false)
            }
        }

        guard let pane else {
            if let previous, let window, window.firstResponder === previous.view {
                // Hand the responder to the webview rather than the bare
                // window: ownership is released exactly when web UI (dialogs,
                // editables, Escape handlers) needs the keyboard, and a
                // window-level first responder dead-ends key events that
                // WebKit would deliver to the DOM.
                if let webView = window.contentView.flatMap({ findWebView(in: $0) }) {
                    window.makeFirstResponder(webView)
                } else {
                    window.makeFirstResponder(nil)
                }
            }
            return true
        }

        pane.isFocused = true
        guard let window else { return false }
        if window.firstResponder === pane.view {
            return true
        }
        return window.makeFirstResponder(pane.view)
    }

    private func findWebView(in root: NSView) -> NSView? {
        if root is WKWebView {
            return root
        }
        for child in root.subviews {
            if let result = findWebView(in: child) {
                return result
            }
        }
        return nil
    }

    private func installEventMonitor() {
        guard eventMonitor == nil else { return }
        let mask: NSEvent.EventTypeMask = [
            .leftMouseDown,
            .leftMouseUp,
            .leftMouseDragged,
            .rightMouseDown,
            .rightMouseUp,
            .rightMouseDragged,
            .otherMouseDown,
            .otherMouseUp,
            .otherMouseDragged,
            .mouseMoved,
            .scrollWheel,
            .keyDown,
            .keyUp,
            .flagsChanged,
        ]
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) {
            @MainActor [weak self] event in
            guard let self else { return event }
            return routeEvent(event)
        }
    }

    private func routeEvent(_ event: NSEvent) -> NSEvent? {
        switch event.type {
        case .keyDown:
            return routeKeyEvent(event)
        case .keyUp:
            return routeKeyUpEvent(event)
        case .flagsChanged:
            return routeFlagsChangedEvent(event)
        default:
            return routePointerEvent(event)
        }
    }

    private func keyboardPane(for event: NSEvent) -> NativeTerminalPane? {
        guard event.window === window,
              let pane = keyboardOwnerPane,
              panes[pane.paneID] === pane,
              !pane.view.isHidden,
              pane.acceptsKeyboardInput
        else {
            return nil
        }
        if window?.firstResponder !== pane.view {
            // The webview holding first responder is a signal, not a stray: a
            // click or programmatic focus() just landed in web content and
            // React's ownership revocation is still crossing the IPC bridge.
            // Yanking the responder back here would blur the web editable and
            // type this key into the terminal, so let the event flow to
            // WebKit instead. Re-asserting stays for the nil/window responder
            // states, which genuinely strand keyboard input.
            if let responder = window?.firstResponder as? NSView,
               isInWebView(responder)
            {
                return nil
            }
            if window?.makeFirstResponder(pane.view) != true {
                return nil
            }
        }
        return pane
    }

    private func isInWebView(_ view: NSView) -> Bool {
        var current: NSView? = view
        while let candidate = current {
            if candidate is WKWebView {
                return true
            }
            current = candidate.superview
        }
        return false
    }

    private func routeKeyEvent(_ event: NSEvent) -> NSEvent? {
        guard let pane = keyboardPane(for: event) else {
            return event
        }
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let shortcutModifiers = modifiers.intersection([.shift, .control, .option, .command])
        let key = event.charactersIgnoringModifiers?.lowercased()
        if shortcutModifiers == .command, key == "f" {
            pane.consumedShortcutKeyCodes.insert(event.keyCode)
            pane.requestSearch()
            return nil
        }
        if shortcutModifiers == .command, key == "v" {
            pane.consumedShortcutKeyCodes.insert(event.keyCode)
            pane.requestPaste()
            return nil
        }
        // Ask Rust to classify the chord into an exact qmux command. The event
        // is consumed only when a semantic command was emitted; everything
        // else stays in the native responder chain for Ghostty/AppKit.
        let hasPrimaryModifier = modifiers.contains(.command) || modifiers.contains(.control)
        let isNativeCommand = modifiers.contains(.command) && (key == "c" || key == "q")
        if hasPrimaryModifier, !isNativeCommand, let key,
           let shortcutKey = webShortcutKey(for: key)
        {
            if pane.reportShortcut(key: shortcutKey, event: event) {
                return nil
            }
        }
        if key == "\u{1b}",
           !modifiers.contains(.command),
           !modifiers.contains(.control),
           !modifiers.contains(.option)
        {
            pane.reportEscape()
        }
        if key != nil, !modifiers.contains(.command) {
            pane.reportUserInput()
        }
        return event
    }

    private func routeKeyUpEvent(_ event: NSEvent) -> NSEvent? {
        guard event.window === window else { return event }
        if panes.values.contains(where: {
            $0.consumedShortcutKeyCodes.remove(event.keyCode) != nil
        }) {
            return nil
        }
        guard event.modifierFlags.contains(.command),
              let pane = keyboardPane(for: event)
        else {
            return event
        }
        // AppKit does not deliver Command-modified key-up events through the
        // ordinary responder chain. Match Ghostty's upstream AppKit host and
        // forward them exactly once.
        pane.view.keyUp(with: event)
        return nil
    }

    private func routeFlagsChangedEvent(_ event: NSEvent) -> NSEvent? {
        guard let pane = keyboardPane(for: event) else {
            return event
        }
        pane.reportCommandModifier(active: event.modifierFlags.contains(.command))
        return event
    }

    /// Translates AppKit key characters into the key names shared by the Rust
    /// and React shortcut classifiers. Returns nil for keys with no equivalent,
    /// which then stay in the native responder chain.
    private func webShortcutKey(for key: String) -> String? {
        switch key {
        case "\r": return "Enter"
        case "\t", "\u{19}": return "Tab"
        case "\u{1b}": return "Escape"
        case "\u{7f}": return "Backspace"
        case "\u{F700}": return "ArrowUp"
        case "\u{F701}": return "ArrowDown"
        case "\u{F702}": return "ArrowLeft"
        case "\u{F703}": return "ArrowRight"
        default:
            guard let scalar = key.unicodeScalars.first,
                  key.unicodeScalars.count == 1,
                  scalar.value >= 0x20,
                  // Function keys land in the Unicode private use area.
                  scalar.value < 0xF700
            else {
                return nil
            }
            return key
        }
    }

    private func routePointerEvent(_ event: NSEvent) -> NSEvent? {
        guard event.window === window else { return event }
        // WKWebView owns the complete gesture while a web control claims pointer
        // routing (resize drags, open menus over the terminal, etc.). Returning
        // the event is essential: consuming it here would bypass DOM hit-testing
        // as soon as the cursor crossed a terminal surface.
        if webPointerRoutingClaimed {
            if isPointerUp(event), webPointerClaimClearsOnPointerUp {
                // Safety net for a drag control unmounting before its cleanup
                // invoke: a mouse gesture cannot remain active after button-up.
                // Sticky claims (menus) intentionally survive until released.
                webPointerRoutingClaimed = false
                webPointerClaimClearsOnPointerUp = false
            }
            return event
        }
        guard let container else { return event }
        let pane: NativeTerminalPane?
        if isPointerContinuation(event), let pointerCapturePane {
            pane = pointerCapturePane
        } else {
            let point = container.convert(event.locationInWindow, from: nil)
            // Web controls floating over the terminal own their rectangle
            // outside an active terminal drag: returning the event keeps DOM
            // hit-testing (and the button's click) working, while a gesture
            // that started inside the terminal stays captured above.
            if webOverlayRegions.values.contains(where: { $0.contains(point) }) {
                return event
            }
            pane = panes.values.first {
                !$0.view.isHidden
                    && $0.acceptsPointerInput
                    && $0.view.frame.contains(point)
            }
        }
        guard let pane else { return event }

        // Ghostty treats the middle button as an unconditional paste trigger.
        // Route it through qmux's approval flow instead, and consume the whole
        // gesture so Ghostty never sees a dangling press or release.
        if isMiddleMouseEvent(event) {
            if event.type == .otherMouseDown {
                pane.acceptsKeyboardInput = true
                setKeyboardOwner(pane)
                pane.reportActivation()
                pane.requestPaste()
            }
            return nil
        }

        if isPointerDown(event) {
            pointerCapturePane = pane
            pane.acceptsKeyboardInput = true
            setKeyboardOwner(pane)
        }
        forward(event, to: pane.view)
        if isPointerUp(event) {
            pointerCapturePane = nil
        }
        // Let the webview observe presses so React can update the active pane;
        // continuations and scrolling stay native to avoid duplicate handling.
        // The webview may reclaim first responder while processing the returned
        // press. Re-assert the explicit owner once dispatch completes, or the
        // first keystroke after a terminal click can land in WKWebView.
        if isPointerDown(event) {
            // A right-click must stay native so WKWebView cannot open a second
            // context menu. Tell React which split pane became active through
            // the event bridge instead of returning the press to the webview.
            if event.type == .rightMouseDown {
                pane.reportActivation()
                return nil
            }
            DispatchQueue.main.async { [weak self, weak pane] in
                guard let self, let pane,
                      self.keyboardOwnerPane === pane,
                      pane.acceptsKeyboardInput,
                      self.panes[pane.paneID] === pane,
                      self.window?.firstResponder !== pane.view
                else { return }
                self.window?.makeFirstResponder(pane.view)
            }
            return event
        }
        // The terminal container deliberately opts out of hit testing, so
        // WKWebView remains responsible for AppKit cursor selection even while
        // Ghostty renders beneath it. Give passive movement to both views:
        // Ghostty needs it for terminal mouse reporting, while WebKit needs it
        // to clear a resize cursor when the pointer leaves a web scrubber.
        if event.type == .mouseMoved {
            return event
        }
        return nil
    }

    private func forward(_ event: NSEvent, to view: TerminalView) {
        switch event.type {
        case .leftMouseDown: view.mouseDown(with: event)
        case .leftMouseUp: view.mouseUp(with: event)
        case .leftMouseDragged: view.mouseDragged(with: event)
        case .rightMouseDown: view.rightMouseDown(with: event)
        case .rightMouseUp: view.rightMouseUp(with: event)
        case .rightMouseDragged: view.rightMouseDragged(with: event)
        case .otherMouseDown: view.otherMouseDown(with: event)
        case .otherMouseUp: view.otherMouseUp(with: event)
        case .otherMouseDragged: view.otherMouseDragged(with: event)
        case .mouseMoved: view.mouseMoved(with: event)
        case .scrollWheel: view.scrollWheel(with: event)
        default: break
        }
    }

    private func isPointerDown(_ event: NSEvent) -> Bool {
        switch event.type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown: true
        default: false
        }
    }

    private func isPointerUp(_ event: NSEvent) -> Bool {
        switch event.type {
        case .leftMouseUp, .rightMouseUp, .otherMouseUp: true
        default: false
        }
    }

    private func isPointerContinuation(_ event: NSEvent) -> Bool {
        switch event.type {
        case .leftMouseDragged,
             .leftMouseUp,
             .rightMouseDragged,
             .rightMouseUp,
             .otherMouseDragged,
             .otherMouseUp:
            true
        default:
            false
        }
    }

    private func isMiddleMouseEvent(_ event: NSEvent) -> Bool {
        switch event.type {
        case .otherMouseDown, .otherMouseUp, .otherMouseDragged:
            event.buttonNumber == 2
        default:
            false
        }
    }
}
