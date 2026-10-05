import assert from "node:assert/strict";
import test from "node:test";
import { RemotePreviewRequests, type RemotePreviewState, type RemotePreviewStatus } from "../src/lib/remotePreview";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const target = { paneId: "p", transcript: "session", path: "report.html", fragment: "#results" };
const ready: RemotePreviewStatus = { bytes: 3, total: 3, url: "http://localhost/snapshot", fetchedAt: 1234, cachedAvailable: false, error: null };
const flush = () => new Promise<void>((r) => setImmediate(r));
test("closing before start resolves releases the late handle without opening anything", async () => {
  const start = deferred<string>(); const closed: string[] = []; let states: Record<string, RemotePreviewState> = {};
  const requests = new RemotePreviewRequests({ start: () => start.promise, status: async () => { throw Error("must not poll"); }, close: async (id) => { closed.push(id); } }, (s) => states = s);
  requests.open(target); requests.close("p"); start.resolve("late"); await flush();
  assert.deepEqual(closed, ["late"]); assert.deepEqual(states, {});
});
test("a superseded session cannot publish its completed preview", async () => {
  const old = deferred<RemotePreviewStatus>(); let sequence = 0; const closed: string[] = []; let states: Record<string, RemotePreviewState> = {};
  const requests = new RemotePreviewRequests({ start: async () => String(++sequence), status: (id) => id === "1" ? old.promise : Promise.resolve(ready), close: async (id) => { closed.push(id); } }, (s) => states = s);
  requests.open(target); await flush();
  requests.open({ ...target, transcript: "next" }); await flush();
  old.resolve({ ...ready, url: "wrong" }); await flush();
  assert.equal(states.p.target.transcript, "next"); assert.equal(states.p.url, ready.url);
  assert.deepEqual(closed, ["1"]); requests.dispose(); assert.deepEqual(closed, ["1", "2"]);
});
test("cached-copy requests skip refresh and preserve the fetch timestamp", async () => {
  let cached = false; let states: Record<string, RemotePreviewState> = {};
  const requests = new RemotePreviewRequests({ start: async (_, value) => { cached = value; return "cached"; }, status: async () => ready, close: async () => undefined }, (s) => states = s);
  requests.open(target, true); await flush();
  assert.equal(cached, true); assert.equal(states.p.fetchedAt, 1234); requests.dispose();
});
test("failed refresh exposes the existing cache without automatically opening it", async () => {
  let states: Record<string, RemotePreviewState> = {};
  const requests = new RemotePreviewRequests({ start: async () => "failed", status: async () => ({ ...ready, url: null, fetchedAt: null, error: "Disconnected", cachedAvailable: true }), close: async () => undefined }, (s) => states = s);
  requests.open(target); await flush();
  assert.equal(states.p.url, null); assert.equal(states.p.cachedAvailable, true); assert.equal(states.p.error, "Disconnected"); requests.dispose();
});
