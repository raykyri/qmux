#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
task_native_root="${1:?native terminal build root is required}"
task_arch="$(uname -m)"
task_products="$task_native_root/swiftpm-$task_arch/$task_arch-apple-macosx/release"
task_headers="$task_native_root/swiftpm-$task_arch/artifacts/libghostty-spm/libghostty/GhosttyKit.xcframework/macos-arm64_x86_64/Headers/libghostty"
task_sdk="$(cat "$task_native_root/swift-sdk-$task_arch.txt")"
task_probe_root="$(mktemp -d "${TMPDIR:-/tmp}/qmux-ghostty-resources.XXXXXX")"
trap 'rm -rf "$task_probe_root"' EXIT
task_app="$task_probe_root/GhosttyResourceProbe.app"
mkdir -p "$task_app/Contents/MacOS" "$task_app/Contents/Resources"

cat > "$task_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>GhosttyResourceProbe</string>
<key>CFBundleIdentifier</key><string>app.qmux.ghostty-resource-probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST

cat > "$task_probe_root/main.swift" <<'SWIFT'
import Foundation
import GhosttyTerminal

let expected = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath().path + "/"
for url in [GhosttyRuntimeResources.directoryURL, GhosttyRuntimeResources.terminfoDirectoryURL] {
    guard let url, url.resolvingSymlinksInPath().path.hasPrefix(expected),
          FileManager.default.fileExists(atPath: url.path) else {
        FileHandle.standardError.write(Data("Ghostty resources did not resolve inside the relocated app\n".utf8))
        exit(1)
    }
}
print("Ghostty resources resolved inside the relocated app bundle")
SWIFT

# Resolve the actual Tauri resource mapping instead of assuming the staging path.
task_bundle_source="$(node --input-type=module - "$repo_root" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.macos.conf.json'), 'utf8'));
const entry = Object.entries(config.bundle.resources).find(([, target]) => target === 'GhosttyKit_GhosttyTerminal.bundle');
if (!entry) throw new Error('Ghostty resource bundle is missing from the macOS packaging configuration');
process.stdout.write(path.resolve(root, 'src-tauri', entry[0]));
JS
)"
cp -R "$task_bundle_source" "$task_app/Contents/Resources/GhosttyKit_GhosttyTerminal.bundle"
xcrun swiftc -sdk "$task_sdk" -I "$task_products/Modules" -I "$task_headers" \
  "$task_probe_root/main.swift" "$task_products/libQmuxNativeTerminal.a" \
  -o "$task_app/Contents/MacOS/GhosttyResourceProbe"
"$task_app/Contents/MacOS/GhosttyResourceProbe" "$task_app/Contents/Resources"
