import assert from "node:assert/strict";
import { test } from "node:test";
import {
  QMUX_FILE_HREF_PREFIX,
  absoluteLocalFilePath,
  canPreviewLocalFilePath,
  inlineCodeFilePath,
  isFileServerUrl,
  isQmuxFileHref,
  loopbackHtmlUrl,
  pathFromFileServerUrl,
  pathFromQmuxFileHref,
  resolveLocalLinkPath,
  safeHref,
  terminalLinkTarget,
} from "../src/lib/links";

test("loopbackHtmlUrl recognizes only loopback HTML documents", () => {
  assert.equal(
    loopbackHtmlUrl("http://127.0.0.1:8631/mockup-1-unified.html"),
    "http://127.0.0.1:8631/mockup-1-unified.html",
  );
  assert.equal(
    loopbackHtmlUrl("https://localhost/mockup.HTML?mode=compact#result"),
    "https://localhost/mockup.HTML?mode=compact#result",
  );
  assert.equal(loopbackHtmlUrl("http://localhost/app.js"), undefined);
  assert.equal(loopbackHtmlUrl("http://localhost.example.com/mockup.html"), undefined);
  assert.equal(loopbackHtmlUrl("http://user@localhost/mockup.html"), undefined);
  assert.equal(loopbackHtmlUrl(" http://localhost/mockup.html"), undefined);
});

test("safeHref keeps real http(s)/mailto URLs", () => {
  assert.equal(safeHref("https://example.com/a"), "https://example.com/a");
  assert.equal(safeHref("http://localhost:5173/"), "http://localhost:5173/");
  assert.equal(safeHref("mailto:hi@example.com"), "mailto:hi@example.com");
});

test("safeHref blocks javascript and custom schemes", () => {
  assert.equal(safeHref("javascript:alert(1)"), undefined);
  assert.equal(safeHref("tauri://localhost/"), undefined);
  assert.equal(safeHref("asset://localhost/etc/passwd"), undefined);
});

test("safeHref does not promote absolute Unix paths to https://qmux.invalid", () => {
  const path = "/Users/raymond/Code/multitool/dev/menubar-design-variants.html";
  const href = safeHref(path);
  assert.equal(href, `${QMUX_FILE_HREF_PREFIX}${path}`);
  assert.ok(href && !href.startsWith("https://"), `got ${href}`);
  assert.equal(pathFromQmuxFileHref(href!), path);
});

test("safeHref recognizes file: URLs and common filesystem roots", () => {
  assert.equal(
    safeHref("file:///Users/raymond/report.html"),
    `${QMUX_FILE_HREF_PREFIX}/Users/raymond/report.html`,
  );
  assert.equal(
    absoluteLocalFilePath("/home/ray/out/diagram.svg"),
    "/home/ray/out/diagram.svg",
  );
  assert.equal(
    absoluteLocalFilePath("/tmp/preview.html"),
    "/tmp/preview.html",
  );
});

test("local file links drop trailing source positions and sentence periods before opening", () => {
  assert.equal(
    safeHref("/Users/raymond/Code/foks/README-FOKS.md:36"),
    `${QMUX_FILE_HREF_PREFIX}/Users/raymond/Code/foks/README-FOKS.md`,
  );
  assert.equal(
    safeHref("/Users/raymond/Code/foks/example.ts:760-843"),
    `${QMUX_FILE_HREF_PREFIX}/Users/raymond/Code/foks/example.ts`,
  );
  assert.equal(
    absoluteLocalFilePath("file:///tmp/example.ts:36:8"),
    "/tmp/example.ts",
  );
  assert.equal(
    absoluteLocalFilePath(`${QMUX_FILE_HREF_PREFIX}/tmp/example.ts:36`),
    "/tmp/example.ts",
  );
  assert.equal(
    absoluteLocalFilePath("/workspace/out/example.ts:36"),
    "/workspace/out/example.ts",
  );
  assert.equal(
    pathFromQmuxFileHref(`${QMUX_FILE_HREF_PREFIX}/tmp/example.ts:36:8`),
    "/tmp/example.ts",
  );
  assert.equal(
    absoluteLocalFilePath("C:\\work\\example.ts:36:8"),
    "C:\\work\\example.ts",
  );
  assert.equal(
    safeHref("/Users/raymond/Code/foks/example.html."),
    `${QMUX_FILE_HREF_PREFIX}/Users/raymond/Code/foks/example.html`,
  );
  assert.equal(absoluteLocalFilePath("file:///tmp/example.html."), "/tmp/example.html");
  assert.equal(
    pathFromQmuxFileHref(`${QMUX_FILE_HREF_PREFIX}/tmp/example.html.`),
    "/tmp/example.html",
  );
});

test("local path cleanup does not alter web URL ports or punctuation", () => {
  assert.equal(safeHref("http://localhost:36"), "http://localhost:36/");
  assert.equal(
    safeHref("https://example.com/report.html."),
    "https://example.com/report.html.",
  );
  assert.equal(absoluteLocalFilePath("http://localhost:36"), undefined);
  assert.deepEqual(
    terminalLinkTarget("https://example.com/report.html."),
    { kind: "externalUrl", url: "https://example.com/report.html." },
  );
});

test("inlineCodeFilePath accepts portable .html and .md paths", () => {
  assert.equal(inlineCodeFilePath("dev/mock.html"), "dev/mock.html");
  assert.equal(inlineCodeFilePath("docs/readme.md"), "docs/readme.md");
  assert.equal(inlineCodeFilePath("index.html"), "index.html");
  assert.equal(inlineCodeFilePath("README.md"), "README.md");
  assert.equal(inlineCodeFilePath("./dev/mock.html"), "./dev/mock.html");
  assert.equal(inlineCodeFilePath("../out/index.html"), "../out/index.html");
  assert.equal(inlineCodeFilePath("/tmp/preview.html"), "/tmp/preview.html");
  assert.equal(inlineCodeFilePath(".hidden.md"), ".hidden.md");
  assert.equal(inlineCodeFilePath("foo.bar.html"), "foo.bar.html");
  assert.equal(inlineCodeFilePath("path/to/file.HTML"), "path/to/file.HTML");
  assert.equal(inlineCodeFilePath(".config/notes.md"), ".config/notes.md");
});

test("inlineCodeFilePath rejects spaces, URLs, and non-filename text", () => {
  assert.equal(inlineCodeFilePath("foo bar.html"), undefined);
  assert.equal(inlineCodeFilePath("http://localhost/foo.html"), undefined);
  assert.equal(inlineCodeFilePath("https://example.com/foo.html"), undefined);
  assert.equal(inlineCodeFilePath("example.com/foo.html"), undefined);
  assert.equal(inlineCodeFilePath("//host/foo.html"), undefined);
  assert.equal(inlineCodeFilePath("foo.html?x=1"), undefined);
  assert.equal(inlineCodeFilePath("foo.html#bar"), undefined);
  assert.equal(inlineCodeFilePath("foo.ts"), undefined);
  assert.equal(inlineCodeFilePath("foo.mdx"), undefined);
  assert.equal(inlineCodeFilePath("foo.markdown"), undefined);
  assert.equal(inlineCodeFilePath("foo.htm"), undefined);
  assert.equal(inlineCodeFilePath(".html"), undefined);
  assert.equal(inlineCodeFilePath("foo/bar.ts"), undefined);
  assert.equal(inlineCodeFilePath("C:\\foo\\bar.html"), undefined);
  assert.equal(inlineCodeFilePath("foo\\bar.html"), undefined);
  assert.equal(inlineCodeFilePath(" foo.html"), undefined);
  assert.equal(inlineCodeFilePath("foo.html "), undefined);
  assert.equal(inlineCodeFilePath("open dev/mock.html"), undefined);
  assert.equal(inlineCodeFilePath("mailto:foo.md"), undefined);
  assert.equal(inlineCodeFilePath("foo$bar.html"), undefined);
  assert.equal(inlineCodeFilePath("@scope/file.html"), undefined);
  assert.equal(inlineCodeFilePath("foo%20bar.html"), undefined);
  assert.equal(inlineCodeFilePath("café.md"), undefined);
});

test("safeHref keeps relative qmux-file hrefs minted from inline code", () => {
  assert.equal(safeHref("qmux-file:dev/mock.html"), "qmux-file:dev/mock.html");
  assert.equal(safeHref("qmux-file:docs/readme.md"), "qmux-file:docs/readme.md");
  assert.equal(safeHref("qmux-file:foo.ts"), undefined);
  assert.equal(safeHref("qmux-file:foo bar.html"), undefined);
});

test("safeHref rejects relative links that only resolve against the dummy base", () => {
  // /docs/intro has no file extension and no known FS root — leave it alone.
  // Resolving against the dummy base would make https://qmux.invalid/docs/intro,
  // which is not a real destination and must never reach the native browser.
  // The same applies to document-relative and fragment-only destinations.
  assert.equal(safeHref("/docs/intro"), undefined);
  assert.equal(safeHref("guide/intro"), undefined);
  assert.equal(safeHref("#details"), undefined);
  assert.equal(absoluteLocalFilePath("/docs/intro"), undefined);
});

test("absoluteLocalFilePath accepts extension-bearing multi-segment paths", () => {
  assert.equal(
    absoluteLocalFilePath("/workspace/out/report.html"),
    "/workspace/out/report.html",
  );
  assert.equal(absoluteLocalFilePath("/only-one-segment.html"), undefined);
});

test("isQmuxFileHref and pathFromQmuxFileHref round-trip", () => {
  const path = "/Users/me/file.html";
  const href = `${QMUX_FILE_HREF_PREFIX}${path}`;
  assert.equal(isQmuxFileHref(href), true);
  assert.equal(isQmuxFileHref("https://example.com"), false);
  assert.equal(pathFromQmuxFileHref(href), path);
  assert.equal(pathFromQmuxFileHref("https://example.com"), undefined);
});

test("local preview hints allow renderable files and reject binary packages", () => {
  assert.equal(canPreviewLocalFilePath("/tmp/report.HTML"), true);
  assert.equal(canPreviewLocalFilePath("/tmp/notes.markdown"), true);
  assert.equal(canPreviewLocalFilePath("C:\\tmp\\chart.PNG"), true);
  assert.equal(canPreviewLocalFilePath("/tmp/qmux_0.3.1_universal.dmg"), false);
  assert.equal(canPreviewLocalFilePath("/tmp/installer.pkg"), false);
  assert.equal(canPreviewLocalFilePath("/tmp/archive.zip"), false);
  assert.equal(canPreviewLocalFilePath("/tmp/no-extension"), false);
});

test("isFileServerUrl recognizes token-bearing loopback paths", () => {
  const token = "a".repeat(64);
  assert.equal(
    isFileServerUrl(`http://127.0.0.1:8123/${token}/Users/me/file.html`, 8123),
    true,
  );
  // Without a known port, the 64-hex first path segment is the signal.
  assert.equal(
    isFileServerUrl(`http://127.0.0.1:9000/${token}/Users/me/file.html`, null),
    true,
  );
  // Dev-server URLs without a token segment are not file-server URLs.
  assert.equal(isFileServerUrl("http://localhost:5173/", null), false);
  assert.equal(isFileServerUrl("http://localhost:5173/app", 8123), false);
});

test("pathFromFileServerUrl recovers the encoded filesystem path", () => {
  const token = "a".repeat(64);
  assert.equal(
    pathFromFileServerUrl(`http://127.0.0.1:8123/${token}/Users/me/file.html`, 8123),
    "/Users/me/file.html",
  );
  assert.equal(
    pathFromFileServerUrl(`http://127.0.0.1:8123/${token}/tmp/foo%20bar.html`, 8123),
    "/tmp/foo bar.html",
  );
  assert.equal(pathFromFileServerUrl("http://localhost:5173/app", 8123), undefined);
});

test("resolveLocalLinkPath joins relative transcript paths against pane cwd", () => {
  assert.equal(resolveLocalLinkPath("/tmp/preview.html", "/repo"), "/tmp/preview.html");
  assert.equal(resolveLocalLinkPath("dev/mock.html", "/repo"), "/repo/dev/mock.html");
  assert.equal(resolveLocalLinkPath("./dev/mock.html", "/repo"), "/repo/dev/mock.html");
  assert.equal(resolveLocalLinkPath("../out/index.html", "/repo/dev"), "/repo/out/index.html");
  assert.equal(resolveLocalLinkPath("dev/mock.html"), "dev/mock.html");
});

test("terminal links keep ordinary web URLs external", () => {
  assert.deepEqual(terminalLinkTarget("https://example.com/report.html#result"), {
    kind: "externalUrl",
    url: "https://example.com/report.html#result",
  });
  assert.deepEqual(terminalLinkTarget("mailto:hello@example.com"), {
    kind: "externalUrl",
    url: "mailto:hello@example.com",
  });
});

test("terminal links recognize absolute, file URL, and relative paths", () => {
  assert.deepEqual(terminalLinkTarget("/tmp/report.html:36:8"), {
    kind: "localPath",
    path: "/tmp/report.html",
  });
  assert.deepEqual(terminalLinkTarget("/tmp/report.html:760-843"), {
    kind: "localPath",
    path: "/tmp/report.html",
  });
  assert.deepEqual(terminalLinkTarget("file:///tmp/report%20one.html"), {
    kind: "localPath",
    path: "/tmp/report one.html",
  });
  assert.deepEqual(terminalLinkTarget("dist/report.html:42"), {
    kind: "localPath",
    path: "dist/report.html",
  });
  assert.deepEqual(terminalLinkTarget("report.html:42"), {
    kind: "localPath",
    path: "report.html",
  });
  assert.deepEqual(terminalLinkTarget("example.html."), {
    kind: "localPath",
    path: "example.html",
  });
});

test("terminal links reject unknown schemes and malformed targets", () => {
  assert.equal(terminalLinkTarget("javascript:alert(1)"), undefined);
  assert.equal(terminalLinkTarget("ssh://example.com/path"), undefined);
  assert.equal(terminalLinkTarget("//example.com/report.html"), undefined);
  assert.equal(terminalLinkTarget(" report.html"), undefined);
  assert.equal(terminalLinkTarget("report\n.html"), undefined);
});
