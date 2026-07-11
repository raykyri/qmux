import AppKit
import Foundation
import GhosttyTerminal
import GhosttyTheme

/// qmux's terminal color themes: the built-in qmux palette plus the
/// iTerm2-Color-Schemes catalog bundled with libghostty-spm. Themes apply the
/// same colors to both appearance slots — qmux keeps its own dark chrome and
/// never restyles panes on OS light/dark switches.
enum QmuxTerminalTheme {
    /// Settings value naming the built-in qmux colors. Kept out of the
    /// catalog namespace: no iTerm2 scheme is called "qmux".
    static let defaultName = "qmux"

    /// The default colors qmux shipped with before named themes existed. Also
    /// the fallback for stale settings naming a theme the catalog no longer has.
    static let defaultDefinition = GhosttyThemeDefinition(
        name: defaultName,
        background: "111315",
        foreground: "e7e7e2",
        cursorColor: "f2d37b",
        cursorText: "111315",
        selectionBackground: "3d4a52",
        selectionForeground: "f4f4ef"
    )

    static func definition(named name: String) -> GhosttyThemeDefinition {
        if name == defaultName {
            return defaultDefinition
        }
        return GhosttyThemeCatalog.theme(named: name) ?? defaultDefinition
    }

    static func theme(named name: String) -> TerminalTheme {
        definition(named: name).toTerminalTheme()
    }

    /// The theme's background as a layer color, for the pre-first-frame pixels
    /// painted behind Ghostty surfaces (pane layers and the stage backstop).
    static func backgroundColor(named name: String) -> CGColor {
        cgColor(fromHex: definition(named: name).background)
            ?? cgColor(fromHex: defaultDefinition.background)!
    }

    private static func cgColor(fromHex hex: String) -> CGColor? {
        let trimmed = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard trimmed.count == 6,
              let red = UInt8(trimmed.prefix(2), radix: 16),
              let green = UInt8(trimmed.dropFirst(2).prefix(2), radix: 16),
              let blue = UInt8(trimmed.dropFirst(4).prefix(2), radix: 16)
        else {
            return nil
        }
        return CGColor(
            srgbRed: CGFloat(red) / 255.0,
            green: CGFloat(green) / 255.0,
            blue: CGFloat(blue) / 255.0,
            alpha: 1
        )
    }

    private struct CatalogEntry: Encodable {
        let name: String
        let background: String
        let foreground: String
        let isDark: Bool
        let palette: [String]
    }

    /// The full catalog (qmux first, then every bundled scheme) as JSON for the
    /// settings UI: name, background/foreground hex, dark/light grouping, and
    /// the 16 ANSI palette colors for preview swatches. Computed once; the
    /// catalog is static data.
    static let catalogJSON: String = {
        let entries = ([defaultDefinition] + GhosttyThemeCatalog.allThemes).map { theme in
            CatalogEntry(
                name: theme.name,
                background: theme.background,
                foreground: theme.foreground,
                isDark: theme.isDark,
                palette: (0..<16).map { theme.palette[$0] ?? "" }
            )
        }
        guard let data = try? JSONEncoder().encode(entries) else {
            return "[]"
        }
        return String(decoding: data, as: UTF8.self)
    }()
}
