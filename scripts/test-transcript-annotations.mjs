import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

// Compiled output stays inside the repo so Node can resolve modules from
// node_modules if the import chain reaches them.
const outDir = join(process.cwd(), "node_modules/.cache/qmux-transcript-annotation-tests");
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
    "--jsx",
    "react-jsx",
    "--esModuleInterop",
    "--allowSyntheticDefaultImports",
    "--outDir",
    outDir,
    "--rootDir",
    ".",
    "--noEmit",
    "false",
    "tests/transcriptAnnotations.test.ts",
  ],
  { stdio: "inherit" },
);

execFileSync("node", ["--test", join(outDir, "tests/transcriptAnnotations.test.js")], {
  stdio: "inherit",
});
