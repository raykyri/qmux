import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qmux-release-script-"));
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const bundle = join(root, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle");
  mkdirSync(scripts);
  mkdirSync(bin);
  mkdirSync(join(bundle, "macos", "qmux.app"), { recursive: true });
  mkdirSync(join(bundle, "dmg"));
  copyFileSync(fileURLToPath(new URL("../scripts/release.sh", import.meta.url)), join(scripts, "release.sh"));
  writeFileSync(join(root, "package.json"), '{"version": "1.2.3"}\n');
  writeFileSync(join(root, "src-tauri", "tauri.conf.json"), '{"version": "1.2.3"}\n');
  writeFileSync(join(root, "src-tauri", "Cargo.toml"), '[package]\nversion = "1.2.3"\n');
  for (const path of ["dmg/qmux_1.2.3_aarch64.dmg", "macos/qmux.app.tar.gz", "macos/qmux.app.tar.gz.sig", "macos/latest.json"]) {
    writeFileSync(join(bundle, path), "fixture artifact");
  }
  // The real release orchestrator runs under macOS Bash 3.2. Stub external
  // work so both notarization paths can be exercised without credentials.
  for (const name of ["build.sh", "generate-latest-json.sh"]) {
    writeFileSync(join(scripts, name), '#!/bin/bash\necho "build target=$QMUX_BUILD_TARGET" >> "$RELEASE_LOG"\n', { mode: 0o755 });
  }
  writeFileSync(join(scripts, "verify-macos-release.sh"), `#!/bin/bash
echo "verify $*" >> "$RELEASE_LOG"
exit "\${VERIFIER_STATUS:-0}"
`, { mode: 0o755 });
  writeFileSync(join(bin, "git"), `#!/bin/bash
if [[ "$1" == rev-parse ]]; then
  [[ "$2" != -q ]] || exit 1
  echo fixture-commit
fi
`, { mode: 0o755 });
  writeFileSync(join(bin, "npm"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "gh"), `#!/bin/bash
echo "gh $*" >> "$RELEASE_LOG"
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == --notes-file ]]; then
    cp "$2" "$RELEASE_NOTES"
    break
  fi
  shift
done
`, { mode: 0o755 });
  return {
    run: (notarized: boolean, verifierStatus = 0) => spawnSync("/bin/bash", [join(scripts, "release.sh")], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root,
        RELEASE_LOG: join(root, "release.log"), VERIFIER_STATUS: String(verifierStatus),
        RELEASE_NOTES: join(root, "notes.md"),
        APPLE_SIGNING_IDENTITY: "Developer ID Application: Fixture",
        TAURI_SIGNING_PRIVATE_KEY: "fixture key",
        ...(notarized
          ? { APPLE_ID: "fixture", APPLE_PASSWORD: "fixture", APPLE_TEAM_ID: "fixture" }
          : { QMUX_ALLOW_UNNOTARIZED: "1" }),
      },
    }),
    log: () => readFileSync(join(root, "release.log"), "utf8"),
    notes: () => readFileSync(join(root, "notes.md"), "utf8"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const notarized of [true, false]) {
  test(`release verifies all artifacts before creating a draft (notarized=${notarized})`, (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const result = f.run(notarized);
    assert.equal(result.status, 0, result.stderr);
    const log = f.log();
    assert.match(log, /build target=aarch64-apple-darwin/);
    assert.match(log, /verify .*qmux\.app .*_aarch64\.dmg .*qmux\.app\.tar\.gz/);
    assert.equal(log.includes("--skip-notarization"), !notarized);
    assert.ok(log.indexOf("verify ") < log.indexOf("gh release create"));
    assert.match(log, /gh release create v1\.2\.3 --draft/);
    assert.match(log, /--generate-notes --notes-file/);
    assert.match(f.notes(), /Requires macOS 13 or later on an Apple Silicon Mac/);
    assert.match(f.notes(), /v0\.4\.0, the final universal release/);
    assert.match(f.notes(), /Rosetta/);
  });

  test(`release never uploads rejected artifacts (notarized=${notarized})`, (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const result = f.run(notarized, 42);
    assert.equal(result.status, 42, result.stderr);
    assert.match(f.log(), /verify /);
    assert.doesNotMatch(f.log(), /gh release create/);
  });
}
