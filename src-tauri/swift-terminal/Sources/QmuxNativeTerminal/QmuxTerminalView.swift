import AppKit
import GhosttyTerminal

/// qmux-specific native menu actions that must live in AppKit rather than in a
/// transparent React overlay above the Metal-backed terminal surface.
final class QmuxTerminalView: TerminalView {
    var onPasteRequest: (() -> Void)?

    override func paste(_: Any?) {
        onPasteRequest?()
    }

    /// Key codes whose *unmodified* character is already a control byte
    /// (Return, keypad Enter, Tab, Escape). For these, a C0 in
    /// `event.characters` is the key itself, not evidence of ctrl
    /// translation, and chords like ctrl+enter must keep Ghostty's richer
    /// encoding (CSI 27;5;13~) instead of collapsing to a raw byte.
    private static let selfControlKeyCodes: Set<UInt16> = [36, 48, 53, 76]

    // Ctrl chords that macOS translates to a C0 control character
    // (ctrl+j -> \n, ctrl+shift+- -> \x1f, ctrl+i -> \t, ...) are sent to the
    // pty as that raw byte, exactly like Terminal.app/iTerm2. The upstream
    // GhosttyTerminal key handler mishandles these two ways: its
    // "interpreted command" replay drops the event text, so ghostty core
    // refuses to encode ctrl+shift chords at all (dead C-_ undo in emacs),
    // and when the translated text does survive (via insertText collection)
    // ghostty's ctrlSeq table has no entry for the control byte and falls
    // back to a fixterms CSI-u sequence — emacs sees `^[[10;5u` for ctrl+j.
    // Sending the byte macOS already computed sidesteps both paths.
    //
    // Deliberately skipped when composing (IMEs own ctrl chords like
    // Japanese ctrl+j mid-composition) and for option/command chords
    // (alt-as-ESC prefixing and app shortcuts keep the normal path).
    override func keyDown(with event: NSEvent) {
        if let scalar = legacyControlScalar(for: event) {
            // A `text:` binding action writes the parsed byte to the pty
            // verbatim. sendText would instead take the text-input path,
            // which normalizes \n to \r and would turn ctrl+j into ctrl+m.
            performBindingAction(String(format: "text:\\x%02x", scalar))
            return
        }
        super.keyDown(with: event)
    }

    private func legacyControlScalar(for event: NSEvent) -> UInt8? {
        let mods = event.modifierFlags.intersection([.shift, .control, .option, .command])
        guard mods.contains(.control),
              !mods.contains(.command),
              !mods.contains(.option),
              !hasMarkedText(),
              !Self.selfControlKeyCodes.contains(event.keyCode),
              let characters = event.characters,
              characters.unicodeScalars.count == 1,
              let scalar = characters.unicodeScalars.first,
              scalar.value < 0x20
        else {
            return nil
        }
        return UInt8(scalar.value)
    }
}
