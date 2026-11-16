import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

function parseVersion(version) {
  const match = typeof version === "string" && version.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  const prerelease = match?.[4]?.split(".") ?? [];
  if (!match || prerelease.some((part) => /^0\d+$/.test(part))) {
    throw new Error(`Invalid release version: ${version}`);
  }
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}

function compareVersions(current, previous) {
  const a = parseVersion(current);
  const b = parseVersion(previous);
  for (let index = 0; index < a.core.length; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

let release = false;
switch (process.env.GITHUB_EVENT_NAME) {
  case "workflow_dispatch":
    release = true;
    console.log("Manual signed release requested.");
    break;
  case "push": {
    const { before } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (/^0+$/.test(before)) {
      console.log("Initial branch push has no previous version; use a manual release.");
      break;
    }
    if (typeof before !== "string" || !/^[0-9a-f]{40,64}$/.test(before)) {
      throw new Error("Missing or invalid previous push commit.");
    }
    const previous = JSON.parse(execFileSync("git", ["show", `${before}:package.json`], {
      encoding: "utf8",
    })).version;
    const current = JSON.parse(readFileSync("package.json", "utf8")).version;
    release = compareVersions(current, previous) > 0;
    console.log(`${previous} → ${current}: ${release ? "start signed release" : "skip signed release"}.`);
    break;
  }
  default:
    throw new Error(`Unsupported release event: ${process.env.GITHUB_EVENT_NAME}`);
}
appendFileSync(process.env.GITHUB_OUTPUT, `release=${release}\n`);
