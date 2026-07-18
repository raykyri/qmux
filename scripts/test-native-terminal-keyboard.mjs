import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const outDir = join(process.cwd(), "node_modules/.cache/qmux-native-terminal-keyboard-tests");
rmSync(outDir, { recursive: true, force: true });

execFileSync(
  join(process.cwd(), "node_modules/.bin/tsc"),
  [
    "--module",
    "commonjs",
    "--moduleResolution",
    "node",
    "--target",
    "ES2020",
    "--lib",
    "ES2020,DOM",
    "--types",
    "node",
    "--skipLibCheck",
    "--strict",
    "--esModuleInterop",
    "--allowSyntheticDefaultImports",
    "--outDir",
    outDir,
    "--rootDir",
    ".",
    "--noEmit",
    "false",
    "tests/nativeTerminalKeyboard.test.ts",
  ],
  { stdio: "inherit" },
);

execFileSync(
  "node",
  ["--test", join(outDir, "tests/nativeTerminalKeyboard.test.js")],
  { stdio: "inherit" },
);
