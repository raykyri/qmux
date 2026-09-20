import AppKit
import CoreGraphics
import Foundation
import XCTest
@testable import QmuxNativeTerminal

/// Mirror of tests/terminalThemeName.test.ts: the four built-in variants and
/// the backgrounds they must paint. The TypeScript side checks the same table
/// against --terminal-pane-bg in src/styles/tokens.css, so a pane's
/// pre-first-frame layer color can never disagree with the surrounding chrome.
final class QmuxTerminalThemeTests: XCTestCase {
    private static let builtInBackgrounds: [(name: String, background: String)] = [
        (QmuxTerminalTheme.defaultName, "111315"),
        (QmuxTerminalTheme.warmName, "161514"),
        (QmuxTerminalTheme.lightName, "f7f8f7"),
        (QmuxTerminalTheme.warmLightName, "f8f6f3"),
    ]

    func testBuiltInDefinitionsCarryTheExpectedBackgrounds() {
        for entry in Self.builtInBackgrounds {
            let definition = QmuxTerminalTheme.definition(named: entry.name)
            XCTAssertEqual(definition.name, entry.name)
            XCTAssertEqual(definition.background, entry.background, entry.name)
        }
    }

    func testBuiltInBackgroundColorsMatchTheirHex() throws {
        for entry in Self.builtInBackgrounds {
            let color = QmuxTerminalTheme.backgroundColor(named: entry.name)
            let components = try XCTUnwrap(color.components, entry.name)
            XCTAssertEqual(components.count, 4, entry.name)
            let channels = stride(from: 0, to: 6, by: 2).map { offset -> CGFloat in
                let start = entry.background.index(entry.background.startIndex, offsetBy: offset)
                let end = entry.background.index(start, offsetBy: 2)
                return CGFloat(UInt8(entry.background[start..<end], radix: 16) ?? 0) / 255.0
            }
            for (index, expected) in channels.enumerated() {
                XCTAssertEqual(components[index], expected, accuracy: 0.001, entry.name)
            }
            XCTAssertEqual(components[3], 1, entry.name)
        }
    }

    func testStaleThemeNameFallsBackToTheDefaultDefinition() {
        let stale = QmuxTerminalTheme.definition(named: "no-such-theme-was-ever-shipped")
        XCTAssertEqual(stale.name, QmuxTerminalTheme.defaultName)
        XCTAssertEqual(stale.background, QmuxTerminalTheme.defaultDefinition.background)
    }

    func testLightVariantsStayOutOfTheUserFacingCatalog() throws {
        let data = try XCTUnwrap(QmuxTerminalTheme.catalogJSON.data(using: .utf8))
        let parsed = try JSONSerialization.jsonObject(with: data)
        let entries = try XCTUnwrap(parsed as? [[String: Any]])
        let names = Set(entries.compactMap { $0["name"] as? String })
        XCTAssertTrue(names.contains(QmuxTerminalTheme.defaultName))
        XCTAssertFalse(names.contains(QmuxTerminalTheme.warmName))
        XCTAssertFalse(names.contains(QmuxTerminalTheme.lightName))
        XCTAssertFalse(names.contains(QmuxTerminalTheme.warmLightName))
    }
}
