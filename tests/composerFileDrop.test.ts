import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { ComposerFileDrops, droppedFileReferences, fileDropInsertion } from "../src/lib/composerFileDrop";

test("file references preserve names, deduplicate paths, and reuse image markers", () => {
  assert.equal(droppedFileReferences(["/tmp/big data.zip", "/tmp/photo.PNG", "/tmp/big data.zip"]),
    '[File: "/tmp/big data.zip"]\n[Image: /tmp/photo.PNG]');
  assert.equal(droppedFileReferences(['/tmp/a]b.png', '/tmp/a\nb.txt', '/tmp/a"b.pdf']),
    '[File: "/tmp/a]b.png"]\n[File: "/tmp/a\\nb.txt"]\n[File: "/tmp/a\\"b.pdf"]');
  assert.equal(fileDropInsertion("Read this", 5, 9, ["/tmp/report.pdf"]), '[File: "/tmp/report.pdf"]');
  assert.equal(fileDropInsertion("beforeafter", 6, 6, ["/tmp/report.pdf"]), '\n[File: "/tmp/report.pdf"]\n');
  assert.equal(fileDropInsertion("unchanged", 0, 9, []), "");
});

test("native drops hit the visible composer at display scale and clear highlights between splits", () => {
  const dom = new JSDOM('<div data-composer-file-drop id="a"><textarea></textarea></div><div data-composer-file-drop id="b"><textarea></textarea></div><div id="overlay"></div>');
  try {
    const doc = dom.window.document;
    const router = new ComposerFileDrops();
    const hover: string[] = [];
    const drops: string[] = [];
    const a = doc.getElementById("a")!;
    const b = doc.getElementById("b")!;
    router.register(a, { onHover: (on) => hover.push(`a:${on}`), onDrop: (paths) => drops.push(`a:${paths.join()}`) });
    const unregister = router.register(b, { onHover: (on) => hover.push(`b:${on}`), onDrop: (paths) => drops.push(`b:${paths.join()}`) });
    let hit: Element | null = a.firstElementChild;
    const atPoint = (x: number, y: number) => {
      assert.equal(x, 100);
      assert.equal(y, 50);
      return hit;
    };
    const position = new PhysicalPosition(200, 100);
    router.handle({ type: "enter", paths: ["/tmp/a.pdf"], position }, 2, false, atPoint);
    hit = b.firstElementChild;
    router.handle({ type: "over", position }, 2, false, atPoint);
    router.clearHover();
    router.handle({ type: "over", position }, 2, false, atPoint);
    router.handle({ type: "drop", paths: ["/tmp/a.pdf"], position }, 2, false, atPoint);
    assert.deepEqual(drops, ["b:/tmp/a.pdf"]);
    assert.deepEqual(hover, ["a:true", "a:false", "b:true", "b:false", "b:true", "b:false"]);

    // Native events can bypass a modal. Both explicit blocking and hit testing must reject them.
    assert.equal(router.handle({ type: "drop", paths: ["/tmp/b.pdf"], position }, 2, true, atPoint), false);
    b.setAttribute("inert", "");
    assert.equal(router.handle({ type: "drop", paths: ["/tmp/b.pdf"], position }, 2, false, atPoint), false);
    b.removeAttribute("inert");
    hit = doc.getElementById("overlay");
    assert.equal(router.handle({ type: "drop", paths: ["/tmp/b.pdf"], position }, 2, false, atPoint), false);
    hit = b.firstElementChild;
    router.handle({ type: "enter", paths: ["/tmp/b.pdf"], position }, 2, false, atPoint);
    unregister();
    assert.equal(hover.at(-1), "b:false");
    assert.equal(router.handle({ type: "drop", paths: ["/tmp/b.pdf"], position }, 2, false, atPoint), false);
    hit = a.firstElementChild;
    router.handle({ type: "enter", paths: ["/tmp/b.pdf"], position }, 2, false, atPoint);
    router.handle({ type: "leave" }, 2, false, atPoint);
    assert.equal(hover.at(-1), "a:false");
    assert.deepEqual(drops, ["b:/tmp/a.pdf"]);
  } finally {
    dom.window.close();
  }
});
