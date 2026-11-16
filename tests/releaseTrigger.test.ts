import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/check-release-trigger.mjs", import.meta.url));

function fixture(t: TestContext, previous: string, current: string) {
  const root = mkdtempSync(join(tmpdir(), "qmux-release-trigger-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet");
  const commit = (version: string) => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
    git("add", "package.json");
    git("-c", "user.name=Release Test", "-c", "user.email=test@example.com",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
      "commit", "--quiet", "--allow-empty", "-m", "Set version");
    return git("rev-parse", "HEAD");
  };
  const before = commit(previous);
  commit(current);
  return {
    commit,
    run(event = "push", base = before) {
      const payload = join(root, "event.json");
      const output = join(root, "output");
      writeFileSync(payload, JSON.stringify({ before: base }));
      writeFileSync(output, "");
      const result = spawnSync(process.execPath, [script], {
        cwd: root, encoding: "utf8",
        env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: payload, GITHUB_OUTPUT: output },
      });
      return { ...result, output: readFileSync(output, "utf8") };
    },
  };
}

for (const [previous, current, expected] of [
  ["0.4.0", "0.4.1", true],
  ["0.4.9", "0.4.10", true],
  ["0.4.9", "0.5.0", true],
  ["0.9.0", "1.0.0", true],
  ["0.4.0", "0.4.0", false],
  ["0.4.1", "0.4.0", false],
  ["0.4.1+first", "0.4.1+second", false],
  ["0.4.1-rc.9", "0.4.1-rc.10", true],
  ["0.4.1-rc.1", "0.4.1", true],
  ["0.4.1", "0.4.1-rc.1", false],
] as const) {
  test(`push ${previous} → ${current} releases=${expected}`, (t) => {
    const result = fixture(t, previous, current).run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, `release=${expected}\n`);
  });
}

test("a multi-commit push compares against the start of the push", (t) => {
  const f = fixture(t, "0.4.0", "0.4.1");
  f.commit("0.4.1");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "release=true\n");
});

test("manual runs remain available without a version change", (t) => {
  const result = fixture(t, "0.4.0", "0.4.0").run("workflow_dispatch", "");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "release=true\n");
});

test("initial branch pushes do not create an accidental release", (t) => {
  const result = fixture(t, "0.4.0", "0.4.1").run("push", "0".repeat(40));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "release=false\n");
});

test("invalid versions fail before allowing a signed build", (t) => {
  const result = fixture(t, "0.4.0", "0.4.1-01").run();
  assert.notEqual(result.status, 0);
  assert.equal(result.output, "");
});

test("an unavailable previous commit fails before allowing a signed build", (t) => {
  const result = fixture(t, "0.4.0", "0.4.1").run("push", "a".repeat(40));
  assert.notEqual(result.status, 0);
  assert.equal(result.output, "");
});
