import AppKit
import Foundation
import GhosttyTerminal
import GhosttyTheme

/// qmux's terminal color themes: the built-in qmux palette plus the
/// iTerm2-Color-Schemes catalog bundled with libghostty-spm. Every theme puts
/// the same colors in both of Ghostty's appearance slots, so panes never
/// restyle themselves on an OS light/dark switch. Appearance is an application
/// setting instead: while the built-in qmux theme is selected, qmux picks one
/// of the four variants below to match the app-selected appearance and color
/// theme. An explicitly chosen catalog theme keeps its authored colors in every
/// appearance.
enum QmuxTerminalTheme {
    /// Settings value naming the built-in qmux colors. Kept out of the
    /// catalog namespace: no iTerm2 scheme is called "qmux".
    static let defaultName = "qmux"
    /// Internal variant used when Warm blob is active with the built-in qmux
    /// terminal theme. It stays out of the user-facing terminal theme catalog.
    static let warmName = "qmux-warm"
    /// Internal variant used under the light appearance with the built-in qmux
    /// terminal theme. Also kept out of the user-facing catalog.
    static let lightName = "qmux-light"
    /// Internal variant used under the light appearance with Warm blob. Also
    /// kept out of the user-facing catalog.
    static let warmLightName = "qmux-warm-light"

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

    static let warmDefinition = GhosttyThemeDefinition(
        name: warmName,
        background: "161514",
        foreground: "e7e7e2",
        cursorColor: "f2d37b",
        cursorText: "161514",
        selectionBackground: "3d4a52",
        selectionForeground: "f4f4ef"
    )

    /// Light companions of the two dark variants. Their backgrounds must stay
    /// equal to --terminal-pane-bg in src/styles/tokens.css for the matching
    /// appearance, or a pane paints a dark rectangle before its first frame.
    static let lightDefinition = GhosttyThemeDefinition(
        name: lightName,
        background: "f7f8f7",
        foreground: "23282a",
        cursorColor: "9a6b12",
        cursorText: "ffffff",
        selectionBackground: "cfe0ea",
        selectionForeground: "15191a"
    )

    static let warmLightDefinition = GhosttyThemeDefinition(
        name: warmLightName,
        background: "f8f6f3",
        foreground: "23282a",
        cursorColor: "9a6b12",
        cursorText: "ffffff",
        selectionBackground: "cfe0ea",
        selectionForeground: "15191a"
    )

    static func definition(named name: String) -> GhosttyThemeDefinition {
        if name == defaultName {
            return defaultDefinition
        }
        if name == warmName {
            return warmDefinition
        }
        if name == lightName {
            return lightDefinition
        }
        if name == warmLightName {
            return warmLightDefinition
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
