import AppKit
import GhosttyTerminal

@_silgen_name("qmux_native_terminal_did_close")
private func nativeTerminalDidClose(_ paneID: UnsafePointer<CChar>, _ processAlive: Int32)

@_silgen_name("qmux_native_terminal_did_change_title")
private func nativeTerminalDidChangeTitle(
    _ paneID: UnsafePointer<CChar>,
    _ title: UnsafePointer<CChar>
)

@_silgen_name("qmux_native_terminal_did_change_cwd")
private func nativeTerminalDidChangeCwd(
    _ paneID: UnsafePointer<CChar>,
    _ cwd: UnsafePointer<CChar>
)

@_silgen_name("qmux_native_terminal_did_resize")
private func nativeTerminalDidResize(_ paneID: UnsafePointer<CChar>, _ columns: Int32, _ rows: Int32)

@_silgen_name("qmux_native_terminal_did_request_search")
private func nativeTerminalDidRequestSearch(_ paneID: UnsafePointer<CChar>)

@_silgen_name("qmux_native_terminal_did_request_paste")
private func nativeTerminalDidRequestPaste(
    _ paneID: UnsafePointer<CChar>,
    _ text: UnsafePointer<CChar>
)

@_silgen_name("qmux_native_terminal_did_receive_user_input")
private func nativeTerminalDidReceiveUserInput(_ paneID: UnsafePointer<CChar>)

@_silgen_name("qmux_native_terminal_did_receive_escape")
private func nativeTerminalDidReceiveEscape(_ paneID: UnsafePointer<CChar>)

@_silgen_name("qmux_native_terminal_did_receive_shortcut")
private func nativeTerminalDidReceiveShortcut(
    _ paneID: UnsafePointer<CChar>,
    _ key: UnsafePointer<CChar>,
    _ shift: Int32,
    _ control: Int32,
    _ option: Int32,
    _ command: Int32,
    _ repeat: Int32
) -> Int32

@_silgen_name("qmux_native_terminal_did_change_command_modifier")
private func nativeTerminalDidChangeCommandModifier(
    _ paneID: UnsafePointer<CChar>,
    _ active: Int32
)

@_silgen_name("qmux_native_terminal_did_activate")
private func nativeTerminalDidActivate(_ paneID: UnsafePointer<CChar>)

@_silgen_name("qmux_native_terminal_did_open_url")
private func nativeTerminalDidOpenURL(
    _ paneID: UnsafePointer<CChar>,
    _ url: UnsafePointer<CChar>
)

@MainActor
final class NativeTerminalPane: NSObject,
    TerminalSurfaceCloseDelegate,
    TerminalSurfaceTitleDelegate,
    TerminalSurfacePwdDelegate,
    TerminalSurfaceResizeDelegate,
    TerminalSurfaceOpenURLDelegate
{
    let paneID: String
    let view: QmuxTerminalView
    let controller: TerminalController
    private let launcherPath: String
    var acceptsPointerInput = true
    var acceptsKeyboardInput = false
    var isFocused = false
    var consumedShortcutKeyCodes: Set<UInt16> = []
    private var lastUserInputReport = Date.distantPast

    init(
        paneID: String,
        launcherPath: String,
        workingDirectory: String?,
        themeName: String
    ) {
        self.paneID = paneID
        self.launcherPath = launcherPath
        // The explicit theme is load-bearing: TerminalController's own default
        // is Alabaster/Afterglow, which follows the OS appearance — Alabaster
        // would repaint every pane white whenever macOS reports light mode.
        // QmuxTerminalTheme puts the same colors in both appearance slots, so
        // panes track the selected qmux theme instead of the OS appearance.
        controller = TerminalController(
            theme: QmuxTerminalTheme.theme(named: themeName)
        ) { builder in
            builder.withWindowPaddingX(10)
            builder.withWindowPaddingY(10)
            builder.withCustom("command", "direct:\(launcherPath)")
            builder.withCustom("shell-integration", "none")
            builder.withCustom("confirm-close-surface", "false")
            // ⌘Q is passed through the native key monitor so the app menu can
            // run qmux's exit confirmation — Ghostty's own quit binding would
            // consume it first via performKeyEquivalent.
            builder.withCustom("keybind", "super+q=unbind")
            // Ghostty's remaining surface/app-management defaults must go the
            // same way. These chords belong to qmux's shortcut layer (the
            // NativeTerminalHost key monitor + classifiers), which normally
            // consumes them before Ghostty sees a thing — but on any missed
            // path (keyboard-owner/first-responder desync, non-US layouts
            // where charactersIgnoringModifiers isn't the classifier's key,
            // pre-init state gaps) the surface's own default binding would
            // fire instead. ⌘W's close_surface tears the pane down with no
            // qmux confirmation (confirm-close-surface is false above), and
            // the font-size trio silently diverges the surface from qmux's
            // font settings. Once unbound, a missed chord falls through to
            // the running program (e.g. kitty-keyboard-protocol TUIs) or to
            // nothing — never to a divergent Ghostty action. ⌘K (clear
            // screen) and ⌘C (copy) stay bound: those are deliberately left
            // native for a focused terminal.
            for chord in [
                "super+w",  // close_surface, bypassing requestClosePane
                "super+shift+w",  // close_window
                "super+alt+shift+w",  // close_all_windows
                "super+t",  // new_tab — qmux: new pane
                "super+n",  // new_window — qmux: home / launcher
                "super+d",  // new_split:right — qmux: split pane below
                "super+shift+d",  // new_split:down — qmux: split pane below
                "super+comma",  // open_config — qmux: settings
                "super+equal",  // increase_font_size — qmux: font zoom
                "super+plus",  // increase_font_size
                "super+minus",  // decrease_font_size
                "super+zero",  // reset_font_size
                "ctrl+tab",  // next_tab — qmux: cycle pane tab
                "ctrl+shift+tab",  // previous_tab
            ] {
                builder.withCustom("keybind", "\(chord)=unbind")
            }
        }
        view = QmuxTerminalView(frame: .zero)
        super.init()

        // Match the configured Ghostty background so a freshly shown pane
        // paints terminal-colored pixels before its first Metal frame instead
        // of exposing the window's vibrancy material through the transparent
        // webview above it.
        view.layer?.backgroundColor = QmuxTerminalTheme.backgroundColor(
            named: themeName
        )
        view.delegate = self
        view.configuration = TerminalSurfaceOptions(
            backend: .exec,
            workingDirectory: workingDirectory,
            context: .split
        )
        view.autoresizingMask = []
        view.setAccessibilityElement(true)
        view.setAccessibilityLabel("Terminal")
        view.setAccessibilityIdentifier("terminal.\(paneID)")
        view.onPasteRequest = { [weak self] in self?.requestPaste() }
    }

    func terminalDidClose(processAlive: Bool) {
        paneID.withCString { nativeTerminalDidClose($0, processAlive ? 1 : 0) }
        NativeTerminalHost.shared.surfaceDidClose(id: paneID)
    }

    func terminalDidChangeTitle(_ title: String) {
        // Ghostty's default surface title is the exec command, which for qmux
        // panes is the generated launcher script path — never a real title.
        // Only programs setting an OSC title should reach the tab bar.
        if title == launcherPath {
            return
        }
        paneID.withCString { paneID in
            title.withCString { nativeTerminalDidChangeTitle(paneID, $0) }
        }
    }

    func terminalDidChangeWorkingDirectory(_ path: String) {
        paneID.withCString { paneID in
            path.withCString { nativeTerminalDidChangeCwd(paneID, $0) }
        }
    }

    func terminalDidResize(columns: Int, rows: Int) {
        guard let columns = Int32(exactly: columns),
              let rows = Int32(exactly: rows)
        else {
            return
        }
        paneID.withCString { nativeTerminalDidResize($0, columns, rows) }
    }

    func terminalDidRequestOpenURL(_ url: String, kind _: TerminalOpenURLKind) {
        paneID.withCString { paneID in
            url.withCString { nativeTerminalDidOpenURL(paneID, $0) }
        }
    }

    func requestSearch() {
        paneID.withCString { nativeTerminalDidRequestSearch($0) }
    }

    func requestPaste() {
        // Read the pasteboard here, inside the user's ⌘V / menu / middle-click
        // event, so macOS attributes the read to a real paste. A deferred read
        // from the webview counts as programmatic access and trips the
        // pasteboard privacy alert on every paste.
        let text = NSPasteboard.general.string(forType: .string) ?? ""
        paneID.withCString { paneID in
            text.withCString { nativeTerminalDidRequestPaste(paneID, $0) }
        }
    }

    func reportUserInput() {
        let now = Date()
        guard now.timeIntervalSince(lastUserInputReport) >= 0.25 else { return }
        lastUserInputReport = now
        paneID.withCString { nativeTerminalDidReceiveUserInput($0) }
    }

    func reportEscape() {
        paneID.withCString { nativeTerminalDidReceiveEscape($0) }
    }

    func reportShortcut(key: String, event: NSEvent) -> Bool {
        let handled = paneID.withCString { paneID in
            key.withCString { key in
                nativeTerminalDidReceiveShortcut(
                    paneID,
                    key,
                    event.modifierFlags.contains(.shift) ? 1 : 0,
                    event.modifierFlags.contains(.control) ? 1 : 0,
                    event.modifierFlags.contains(.option) ? 1 : 0,
                    event.modifierFlags.contains(.command) ? 1 : 0,
                    event.isARepeat ? 1 : 0
                ) == 1
            }
        }
        if handled {
            consumedShortcutKeyCodes.insert(event.keyCode)
        }
        return handled
    }

    func reportCommandModifier(active: Bool) {
        paneID.withCString {
            nativeTerminalDidChangeCommandModifier($0, active ? 1 : 0)
        }
    }

    func reportActivation() {
        paneID.withCString { nativeTerminalDidActivate($0) }
    }

    func pasteApprovedText(_ text: String) -> Bool {
        view.pasteApprovedText(text)
    }

    func updateSettings(
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
        let style = TerminalCursorStyle(rawValue: cursorStyle) ?? .block
        let scrollbackBytes = max(UInt64(scrollbackRows) * 1024, 1_048_576)
        let configuration = TerminalConfiguration { builder in
            builder.withFontSize(Float(fontSize))
            builder.withFontFamily(fontFamily)
            builder.withCustom(
                "adjust-cell-width",
                "\(letterSpacing / fontSize * 100)%"
            )
            builder.withCustom(
                "adjust-cell-height",
                "\((lineHeight - 1) * 100)%"
            )
            builder.withCursorStyle(style)
            builder.withCursorStyleBlink(cursorBlink)
            builder.withCustom("scrollback-limit", "\(scrollbackBytes)")
            builder.withCustom(
                "scroll-to-bottom",
                scrollOnUserInput ? "keystroke" : "no-keystroke"
            )
            builder.withCustom("mouse-scroll-multiplier", "\(scrollSensitivity)")
            builder.withCustom("copy-on-select", copyOnSelect ? "clipboard" : "false")
            builder.withCustom(
                "selection-clear-on-copy",
                selectionClearOnCopy ? "true" : "false"
            )
        }
        // setTheme and setTerminalConfiguration decline no-op updates with
        // false, but an unchanged Ghostty config is success here; reporting
        // failure for a no-op would surface a spurious settings error in the
        // frontend.
        let theme = QmuxTerminalTheme.theme(named: themeName)
        if theme != controller.theme, !controller.setTheme(theme) {
            return false
        }
        view.layer?.backgroundColor = QmuxTerminalTheme.backgroundColor(
            named: themeName
        )
        if configuration != controller.terminalConfiguration,
           !controller.setTerminalConfiguration(configuration)
        {
            return false
        }
        // Settings such as scrollback-limit only affect newly-created Ghostty
        // surfaces. Hold the controller back until the frontend has supplied the
        // pane's initial settings, regardless of whether layout or settings wins
        // the React-to-native scheduling race.
        if view.controller == nil {
            view.controller = controller
        }
        return true
    }

}
