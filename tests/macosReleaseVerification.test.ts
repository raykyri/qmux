import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const verifier = fileURLToPath(new URL("../scripts/verify-macos-release.sh", import.meta.url));
const linuxTargets = ["aarch64-unknown-linux-musl", "x86_64-unknown-linux-musl"];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qmux-release-test-"));
  const app = join(root, "bundle with spaces", "qmux.app");
  const dmgApp = join(root, "dmg source", "qmux.app");
  const archiveApp = join(root, "archive source", "qmux.app");
  const dmg = join(root, "qmux.dmg");
  const archive = join(root, "qmux.app.tar.gz");
  const bin = join(root, "bin");
  const log = join(root, "tools.log");
  mkdirSync(bin);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", "qmux"), "arm64\nfixture executable");
  writeFileSync(dmg, "");
  for (const target of linuxTargets) {
    const directory = join(app, "Contents", "Resources", "remote-cli", target);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "qmux-cli"), "", { mode: 0o755 });
  }
  cpSync(app, dmgApp, { recursive: true });
  cpSync(app, archiveApp, { recursive: true });
  // Use a real tar archive. Only macOS tools are stubbed; lipo reads a fixture
  // architecture from each copy's executable and validates its actual args.
  const refreshArchive = () => {
    const result = spawnSync("/usr/bin/tar", ["-czf", archive, "-C", join(root, "archive source"), "qmux.app"]);
    assert.equal(result.status, 0, result.stderr?.toString());
  };
  refreshArchive();
  const toolPreamble = `#!/bin/bash
set -euo pipefail
tool="\${0##*/}"
echo "$tool $*" >> "$TOOL_LOG"
if [[ "$tool" == "\${FAIL_CHECK:-}" ]]; then exit 42; fi
`;
  for (const tool of ["codesign", "xcrun", "spctl"]) {
    writeFileSync(join(bin, tool), `${toolPreamble}
if [[ "$tool" == codesign && "$*" == *qmux.dmg* && "\${UNSIGNED_DMG:-}" == 1 ]]; then exit 42; fi
`, { mode: 0o755 });
  }
  writeFileSync(join(bin, "lipo"), `${toolPreamble}
[[ "$#" -eq 2 && "$2" == -archs && -f "$1" ]] || exit 43
head -n 1 "$1"
`, { mode: 0o755 });
  writeFileSync(join(bin, "hdiutil"), `${toolPreamble}
case "$1" in
  attach)
    [[ "$#" -eq 6 && "$3" == -nobrowse && "$4" == -readonly && "$5" == -mountpoint ]] || exit 43
    cp -R "$DMG_APP" "$6/qmux.app"
    ;;
  detach)
    [[ "\${FAIL_CHECK:-}" != detach ]] || exit 42
    rm -rf "$2/qmux.app"
    ;;
  *) exit 43 ;;
esac
`, { mode: 0o755 });
  return {
    app, dmgApp, archiveApp, archive, refreshArchive,
    log: () => readFileSync(log, "utf8"),
    run: (options: { failCheck?: string; skipNotarization?: boolean; noArchive?: boolean; allowUnsignedDmg?: boolean; unsignedDmg?: boolean } = {}) => spawnSync(
      "/bin/bash",
      [verifier, ...(options.skipNotarization ? ["--skip-notarization"] : []), ...(options.allowUnsignedDmg ? ["--allow-unsigned-dmg"] : []), app, dmg, ...(options.noArchive ? [] : [archive])],
      {
        encoding: "utf8",
        cwd: root,
        env: {
          PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, TMPDIR: root,
          FAIL_CHECK: options.failCheck ?? "", DMG_APP: dmgApp, TOOL_LOG: log,
          UNSIGNED_DMG: options.unsignedDmg ? "1" : "0",
        },
      },
    ),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("release verification accepts matching ARM app, DMG, and updater archive", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.log().match(/^lipo /gm)?.length, 3);
  assert.match(f.log(), /hdiutil detach/);
});

for (const tool of ["lipo", "codesign", "xcrun", "spctl", "hdiutil"]) {
  test(`release verification stops when ${tool} rejects the artifact`, (t) => {
    const f = fixture();
    t.after(f.cleanup);
    assert.equal(f.run({ failCheck: tool }).status, 42);
  });
}

for (const copy of ["app", "dmgApp", "archiveApp"] as const) {
  for (const archs of ["x86_64", "x86_64 arm64"]) {
    test(`release verification rejects ${archs} in ${copy} even without notarization`, (t) => {
      const f = fixture();
      t.after(f.cleanup);
      writeFileSync(join(f[copy], "Contents", "MacOS", "qmux"), `${archs}\nfixture executable`);
      f.refreshArchive();
      const result = f.run({ skipNotarization: true });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Expected only arm64/);
      if (copy === "dmgApp") assert.match(f.log(), /hdiutil detach/);
    });
  }
  for (const target of linuxTargets) {
    test(`release verification requires executable ${target} in ${copy}`, (t) => {
      const f = fixture();
      t.after(f.cleanup);
      chmodSync(join(f[copy], "Contents", "Resources", "remote-cli", target, "qmux-cli"), 0o644);
      f.refreshArchive();
      const result = f.run();
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Bundled remote CLI is missing or not executable/);
    });
  }
}

for (const copy of ["dmgApp", "archiveApp"] as const) {
  test(`release verification rejects a stale ARM executable in ${copy}`, (t) => {
    const f = fixture();
    t.after(f.cleanup);
    writeFileSync(join(f[copy], "Contents", "MacOS", "qmux"), "arm64\nstale executable");
    f.refreshArchive();
    const result = f.run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Packaged executable differs/);
  });
}

test("development verification checks the app and DMG while skipping only notarization", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const result = f.run({ skipNotarization: true, noArchive: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.log().match(/^lipo /gm)?.length, 2);
  assert.match(f.log(), /codesign/);
  assert.doesNotMatch(f.log(), /xcrun|spctl/);
});

test("release verification rejects a corrupt updater archive", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  writeFileSync(f.archive, "not an archive");
  assert.notEqual(f.run().status, 0);
});

test("CI accepts an unsigned development DMG while verifying both app copies", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const result = f.run({ skipNotarization: true, allowUnsignedDmg: true, unsignedDmg: true, noArchive: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.log().match(/^lipo /gm)?.length, 2);
  assert.equal(f.log().match(/^codesign --verify --deep/gm)?.length, 2);
  assert.match(f.log(), /codesign --display .*qmux\.dmg/);
  assert.doesNotMatch(f.log(), /codesign --verify --strict .*qmux\.dmg/);
});

test("an unsigned DMG is rejected unless development verification explicitly allows it", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.equal(f.run({ skipNotarization: true, unsignedDmg: true }).status, 42);
});

test("notarized release verification cannot allow unsigned DMGs", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const result = f.run({ allowUnsignedDmg: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /only supported with --skip-notarization/);
});

test("release verification fails if its DMG cannot be detached", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const result = f.run({ failCheck: "detach" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not detach verification DMG/);
});
