import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";
import {
  browserRoute,
  browserHistoryDirection,
  matchesBrowserDocument,
  trustedBrowserUrl,
  type BrowserHandlers,
} from "../src/research-browser/protocol";
import { createBrowserRpc, serveBrowserRpc } from "../src/research-browser/rpc";
import { conversationPath } from "../src/research-browser/conversation";
import type { ResearchTreeDetail } from "../src/types";

test("only explicitly selected loopback template documents match", () => {
  assert.equal(
    trustedBrowserUrl("http://localhost:1421/index.html#activity"),
    "http://localhost:1421/index.html",
  );
  for (const url of [
    "https://example.com",
    "http://localhost.evil.test",
    "file:///tmp/view.html",
    "http://user@localhost:1421",
    "javascript:alert(1)",
  ])
    assert.throws(() => trustedBrowserUrl(url));
  assert.ok(
    matchesBrowserDocument(
      "http://localhost:1421/index.html#/research/a",
      "http://localhost:1421/index.html",
    ),
  );
  assert.ok(
    !matchesBrowserDocument(
      "http://localhost:1421/other.html",
      "http://localhost:1421/index.html",
    ),
  );
  assert.ok(
    !matchesBrowserDocument(
      "http://localhost:1422/index.html",
      "http://localhost:1421/index.html",
    ),
  );
  assert.ok(
    !matchesBrowserDocument(
      "http://localhost:1421/index.html?other",
      "http://localhost:1421/index.html",
    ),
  );
  assert.equal(
    browserRoute("/research/tree/node/child"),
    "/research/tree/node/child",
  );
  assert.throws(() => browserRoute("https://example.com"));
  assert.throws(() => browserRoute("/research/%invalid"));
});

test("RPC correlates out-of-order responses, forwards events and preserves errors", async () => {
  const { port1, port2 } = new MessageChannel();
  let finishFirst: ((value: string) => void) | undefined;
  const stop = serveBrowserRpc(
    port1 as unknown as MessagePort,
    () =>
      ({
        "research.getTree": (id: string) =>
          id === "first"
            ? new Promise((resolve) => {
                finishFirst = resolve;
              })
            : Promise.resolve(id),
        "research.updateDocument": () =>
          Promise.reject({ code: "conflict", currentRevision: "r2" }),
      }) as unknown as BrowserHandlers,
  );
  const events: unknown[] = [];
  const client = createBrowserRpc(
    port2 as unknown as MessagePort,
    (name, value) => events.push([name, value]),
  );
  try {
    const first = client.call("research.getTree", "first");
    assert.equal(await client.call("research.getTree", "second"), "second");
    finishFirst!("first-result");
    assert.equal(await first, "first-result");
    port1.postMessage({
      type: "event",
      name: "research.changed",
      value: { nodeId: "n" },
    });
    await assert.rejects(
      client.call("research.updateDocument", {} as never),
      (error) => {
        assert.equal((error as any).details.code, "conflict");
        return true;
      },
    );
    assert.deepEqual(events, [["research.changed", { nodeId: "n" }]]);
    await assert.rejects(
      client.call("toString" as never),
      /Unsupported SDK method/,
    );
    await assert.rejects(
      client.call("__proto__" as never),
      /Unsupported SDK method/,
    );
  } finally {
    client.dispose();
    stop();
  }
});

test("disconnect rejects pending writes and never replays them", async () => {
  const { port1, port2 } = new MessageChannel();
  let writes = 0;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stop = serveBrowserRpc(
    port1 as unknown as MessagePort,
    () =>
      ({
        "journal.add": () => {
          writes++;
          entered();
          return new Promise(() => {});
        },
      }) as unknown as BrowserHandlers,
  );
  const client = createBrowserRpc(port2 as unknown as MessagePort, () => {});
  try {
    const pending = client.call("journal.add", "note");
    const rejection = assert.rejects(pending, /reloaded/);
    await started;
    client.dispose();
    await rejection;
    assert.equal(writes, 1);
    await assert.rejects(
      client.call("journal.add", "another note"),
      /disconnected/,
    );
    assert.equal(writes, 1);
  } finally {
    client.dispose();
    stop();
  }
});

test("conversation routes load full ancestry and the tree's inline tail, guarding cycles", () => {
  const detail = {
    tree: { rootNodeId: "root" },
    nodes: [
      { id: "root" },
      { id: "inline", parentNodeId: "root", inline: true, createdAt: 1 },
      { id: "branch", parentNodeId: "root" },
      { id: "leaf", parentNodeId: "branch" },
    ],
  } as ResearchTreeDetail;
  assert.deepEqual(
    conversationPath(detail).map((node) => node.id),
    ["root", "inline"],
  );
  assert.deepEqual(
    conversationPath(detail, "leaf").map((node) => node.id),
    ["root", "branch", "leaf"],
  );
  assert.throws(() => conversationPath(detail, "deleted"), /no longer exists/);
  detail.nodes[0].parentNodeId = "leaf";
  assert.equal(conversationPath(detail, "leaf").length, 3);
});

test("history keys work in either document but preserve text editing", () => {
  const input = {
    key: "[",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };
  assert.equal(browserHistoryDirection(input), -1);
  assert.equal(browserHistoryDirection({ ...input, key: "]" }), 1);
  assert.equal(
    browserHistoryDirection({ ...input, editableTarget: true }),
    null,
  );
  assert.equal(browserHistoryDirection({ ...input, shiftKey: true }), null);
  assert.equal(
    browserHistoryDirection({
      ...input,
      metaKey: false,
      altKey: true,
      key: "ArrowLeft",
    }),
    -1,
  );
});
