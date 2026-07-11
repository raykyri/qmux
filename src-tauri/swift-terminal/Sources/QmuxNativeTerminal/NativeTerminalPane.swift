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
        workingDirectory: String?
    ) {
        self.paneID = paneID
        self.launcherPath = launcherPath
        // The empty theme is load-bearing: TerminalController appends its theme
        // *after* these builder lines in the rendered Ghostty config, and the
        // default theme is Alabaster/Afterglow — Alabaster would repaint every
        // pane white whenever macOS reports a light appearance. qmux panes match
        // the app's own dark chrome instead of the OS appearance.
        controller = TerminalController(theme: TerminalTheme()) { builder in
            builder.withBackground("111315")
            builder.withForeground("e7e7e2")
            builder.withSelectionBackground("3d4a52")
            builder.withSelectionForeground("f4f4ef")
            builder.withCursorColor("f2d37b")
            builder.withCursorText("111315")
            builder.withWindowPaddingX(10)
            builder.withWindowPaddingY(10)
            builder.withCustom("command", "direct:\(launcherPath)")
            builder.withCustom("shell-integration", "none")
            builder.withCustom("confirm-close-surface", "false")
            // ⌘Q is passed through the native key monitor so the app menu can
            // run qmux's exit confirmation — Ghostty's own quit binding would
            // consume it first via performKeyEquivalent.
            builder.withCustom("keybind", "super+q=unbind")
        }
        view = QmuxTerminalView(frame: .zero)
        super.init()

        // Match the configured Ghostty background so a freshly shown pane
        // paints terminal-colored pixels before its first Metal frame instead
        // of exposing the window's vibrancy material through the transparent
        // webview above it.
        view.layer?.backgroundColor = CGColor(
            srgbRed: 0x11 / 255.0,
            green: 0x13 / 255.0,
            blue: 0x15 / 255.0,
            alpha: 1
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
        selectionClearOnCopy: Bool
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
        // setTerminalConfiguration declines no-op updates with false, but an
        // unchanged Ghostty config is success here; reporting failure for a
        // no-op would surface a spurious settings error in the frontend.
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
