import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

function fixture(script: string) {
  const root = mkdtempSync(join(tmpdir(), "qmux-build-target-"));
  mkdirSync(join(root, "scripts"));
  copyFileSync(fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), join(root, "scripts", script));
  return {
    root,
    run: (target?: string, args: string[] = []) => spawnSync("/bin/bash", [join(root, "scripts", script), ...args], {
      encoding: "utf8",
      cwd: root,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: root,
        ...(target === undefined ? {} : { QMUX_BUILD_TARGET: target }),
      },
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const script of ["build.sh", "release.sh", "generate-latest-json.sh"]) {
  for (const target of ["x86_64-apple-darwin", "universal-apple-darwin"]) {
    test(`${script} rejects ${target} before build or release work`, (t) => {
      // No configuration, tools, or artifacts: target validation must precede
      // version reads, Git access, credential checks, and compilation.
      const f = fixture(script);
      t.after(f.cleanup);
      const result = f.run(target, script === "build.sh" ? ["--notarize"] : []);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /supports only QMUX_BUILD_TARGET=aarch64-apple-darwin/);
      assert.equal(result.stdout, "");
    });
  }
}

test("build and release reject unsupported targets loaded from .env", (t) => {
  for (const script of ["build.sh", "release.sh"]) {
    const f = fixture(script);
    t.after(f.cleanup);
    writeFileSync(join(f.root, ".env"), "QMUX_BUILD_TARGET=universal-apple-darwin\n");
    const result = f.run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /supports only QMUX_BUILD_TARGET=aarch64-apple-darwin/);
  }
});

for (const target of [undefined, "aarch64-apple-darwin"]) {
  test(`build invokes only the ARM target (${target ?? "default target"})`, (t) => {
    const f = fixture("build.sh");
    t.after(f.cleanup);
    const bin = join(f.root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["tauri", "rustup"]) {
      writeFileSync(join(bin, tool), `#!/bin/bash\nprintf '%s\\n' "$@" > "$HOME/${tool}.args"\n`, { mode: 0o755 });
    }
    for (const script of ["build-remote-cli.sh", "cleanup-tauri-dmg.sh"]) {
      writeFileSync(join(f.root, "scripts", script), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    }
    if (target) {
      // A caller's supported explicit target takes precedence over stale .env.
      writeFileSync(join(f.root, ".env"), "QMUX_BUILD_TARGET=universal-apple-darwin\n");
    }
    const result = f.run(target);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.root, "tauri.args"), "utf8"), "build\n--target\naarch64-apple-darwin\n");
    assert.equal(readFileSync(join(f.root, "rustup.args"), "utf8"), "target\nadd\naarch64-apple-darwin\n");
  });
}

for (const target of [undefined, "aarch64-apple-darwin"]) {
  test(`updater manifest advertises only the ARM archive (${target ?? "default target"})`, (t) => {
    const f = fixture("generate-latest-json.sh");
    t.after(f.cleanup);
    const bundle = join(f.root, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle", "macos");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(f.root, "src-tauri", "tauri.conf.json"), '{"version": "1.2.3"}\n');
    writeFileSync(join(bundle, "qmux.app.tar.gz"), "fixture archive");
    const signature = 'untrusted comment: fixture\n$(touch injected) `echo unsafe` "quoted" \\ bytes';
    writeFileSync(join(bundle, "qmux.app.tar.gz.sig"), `${signature}\n`);
    const result = f.run(target);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(bundle, "latest.json"), "utf8"));
    assert.equal(manifest.version, "1.2.3");
    assert.ok(Number.isFinite(Date.parse(manifest.pub_date)));
    assert.deepEqual(manifest.platforms, {
      "darwin-aarch64": {
        signature,
        url: "https://github.com/raykyri/qmux/releases/download/v1.2.3/qmux.app.tar.gz",
      },
    });
    assert.equal(existsSync(join(f.root, "injected")), false);
  });
}
