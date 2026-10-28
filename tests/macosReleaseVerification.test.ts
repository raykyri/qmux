import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const verifier = fileURLToPath(new URL("../scripts/verify-macos-release.sh", import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qmux-release-test-"));
  const app = join(root, "bundle with spaces", "qmux.app");
  const dmg = join(root, "qmux.dmg");
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(dmg, "");
  const clis = ["aarch64-unknown-linux-musl", "x86_64-unknown-linux-musl"].map((target) => {
    const directory = join(app, "Contents", "Resources", "remote-cli", target);
    mkdirSync(directory, { recursive: true });
    const cli = join(directory, "qmux-cli");
    writeFileSync(cli, "", { mode: 0o755 });
    return cli;
  });
  // Stub only the platform checks. Each failure must stop the real verifier;
  // the test does not require signing credentials or invoke Apple services.
  for (const tool of ["lipo", "codesign", "xcrun", "spctl"]) {
    writeFileSync(join(bin, tool), `#!/bin/bash
if [[ "\${0##*/}" == "\${FAIL_CHECK:-}" ]]; then exit 42; fi
exit 0
`, { mode: 0o755 });
  }
  return {
    clis,
    run: (failCheck = "") => spawnSync("/bin/bash", [verifier, app, dmg], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, FAIL_CHECK: failCheck },
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("release verification accepts complete artifacts when platform checks pass", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

for (const tool of ["lipo", "codesign", "xcrun", "spctl"]) {
  test(`release verification stops when ${tool} rejects the artifact`, (t) => {
    const f = fixture();
    t.after(f.cleanup);
    assert.equal(f.run(tool).status, 42);
  });
}

for (const index of [0, 1]) {
  test(`release verification rejects missing remote CLI ${index}`, (t) => {
    const f = fixture();
    t.after(f.cleanup);
    rmSync(f.clis[index]);
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Bundled remote CLI is missing/);
  });
}
