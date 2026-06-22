import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/xterm");

const buildDir = mkdtempSync(join(tmpdir(), "qmux-scrollback-check-"));
execFileSync(
  "npx",
  [
    "tsc",
    "src/lib/terminalScrollback.ts",
    "--target",
    "ES2022",
    "--module",
    "ES2022",
    "--outDir",
    buildDir,
    "--skipLibCheck",
  ],
  { stdio: "inherit" },
);

const { RESTORED_SCROLLBACK_TERMINAL_RESET, sanitizeRestoredScrollback } = await import(
  pathToFileURL(join(buildDir, "terminalScrollback.js")).href
);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const cases = [
  {
    name: "claude-style title and block glyphs",
    bytes: encoder.encode(
      [
        "\x1b]0;✳ Claude Code\x07",
        "\x1b]9;4;0;\x07",
        "\x1b[?2026h",
        "\x1b[38;2;215;119;87m╭───\x1b[6GClaude\x1b[13GCode\x1b[18G",
        "\x1b[38;2;153;153;153mv2.1.185\x1b[27G",
        "\x1b[38;2;215;119;87m───────────────────────────────────────────╮\x1b[39m\r\n",
        "\x1b[38;2;215;119;87m│\x1b[25G▐\x1b[48;2;0;0;0m▛███▜\x1b[49m▌",
        "\x1b[54G│\x1b[56GRun\x1b[60G/init\x1b[66Gto…\x1b[70G│\x1b[39m\r\n",
        "\x1b[38;2;78;186;101m⏺\x1b[3G\x1b[39mRead(src/App.tsx)\r\n",
        "\x1b[?2026l",
        "❯\u00a0",
      ].join(""),
    ),
  },
  {
    name: "post-restore output stays at prompt",
    bytes: encoder.encode("one\r\ntwo\r\n❯\u00a0"),
  },
  {
    name: "utf8 encoded string-control terminator",
    bytes: encoder.encode("\x1b]0;working\u009cvisible\r\n❯\u00a0"),
  },
  {
    name: "alternate-screen output is not restored",
    bytes: encoder.encode(
      [
        "before\r\n",
        "\x1b[?1049h",
        "\x1b[2Jhidden tui text\r\n",
        "\x1b[?1049l",
        "after\r\n",
        "❯\u00a0",
      ].join(""),
    ),
  },
];

for (const testCase of cases) {
  await assertRestoreMatchesLive(testCase.name, testCase.bytes);
}
await assertTrailingTerminalQueriesAreStripped();

console.log(`terminal scrollback replay checks passed (${cases.length} cases)`);

async function assertRestoreMatchesLive(name, bytes) {
  const live = createTerminal();
  const restored = createTerminal();

  await write(live, bytes);
  const sanitized = sanitizeRestoredScrollback(bytes);
  await write(restored, sanitized);
  await write(restored, RESTORED_SCROLLBACK_TERMINAL_RESET);

  assert.deepEqual(snapshot(restored), snapshot(live), `${name}: restored buffer differs`);

  await write(live, "NEXT");
  await write(restored, "NEXT");
  assert.deepEqual(snapshot(restored), snapshot(live), `${name}: next output starts in wrong place`);
}

async function assertTrailingTerminalQueriesAreStripped() {
  const bytes = encoder.encode("prompt \x1b[c\x1b[6n\x1b[?2004$p");
  const raw = createTerminal();
  let rawReplies = "";
  raw.onData((data) => {
    rawReplies += data;
  });
  await write(raw, bytes);
  assert.notEqual(rawReplies, "", "raw terminal queries should make xterm emit replies");

  const restored = createTerminal();
  let restoredReplies = "";
  restored.onData((data) => {
    restoredReplies += data;
  });
  const sanitized = sanitizeRestoredScrollback(bytes);
  assert.equal(decoder.decode(sanitized), "prompt ");
  await write(restored, sanitized);
  await write(restored, RESTORED_SCROLLBACK_TERMINAL_RESET);
  assert.equal(restoredReplies, "", "restored trailing queries should not emit terminal replies");
}

function createTerminal() {
  return new Terminal({
    allowProposedApi: true,
    cols: 72,
    convertEol: false,
    rows: 12,
    scrollback: 10000,
  });
}

function write(terminal, data) {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

function snapshot(terminal) {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return {
    baseY: buffer.baseY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    length: buffer.length,
    lines,
  };
}
