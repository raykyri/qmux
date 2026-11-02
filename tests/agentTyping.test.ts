import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTypingReporter, type AgentTypingUpdate } from "../src/lib/agentTyping";

test("typing updates share document ownership and keep input order across a delayed handshake", async () => {
  let resolve!: (value: string) => void;
  const document = new Promise<string>((done) => { resolve = done; });
  const sent: AgentTypingUpdate[] = [];
  let reads = 0;
  const report = createAgentTypingReporter(() => { reads++; return document; }, async (update) => {
    sent.push(update);
  });
  const updates = [report("a", true), report("a", false), report("b", true), report("a", true)];
  assert.equal(reads, 1);
  assert.deepEqual(sent, []);
  resolve("12");
  await Promise.all(updates);
  assert.deepEqual(sent, [
    { agentId: "a", typing: true, document: "12", sequence: 1 },
    { agentId: "a", typing: false, document: "12", sequence: 2 },
    { agentId: "b", typing: true, document: "12", sequence: 3 },
    { agentId: "a", typing: true, document: "12", sequence: 4 },
  ]);
});

test("failed ownership/update is not replayed and next input can recover", async () => {
  let reads = 0;
  const sent: AgentTypingUpdate[] = [];
  const report = createAgentTypingReporter(async () => `${++reads}`, async (update) => {
    sent.push(update);
    if (sent.length === 1) throw new Error("typing document expired");
  });
  await assert.rejects(report("a", true));
  assert.equal(sent.length, 1);
  await report("a", true);
  assert.deepEqual(sent.map(({ document, sequence }) => [document, sequence]), [["1", 1], ["2", 2]]);
});

test("a failed handshake installs no hold and a later input retries", async () => {
  let reads = 0;
  const sent: AgentTypingUpdate[] = [];
  const report = createAgentTypingReporter(async () => {
    if (++reads === 1) throw new Error("IPC unavailable");
    return "1";
  }, async (update) => { sent.push(update); });
  await assert.rejects(report("a", true));
  assert.deepEqual(sent, []);
  await report("a", false);
  assert.deepEqual(sent.map(({ typing, sequence }) => [typing, sequence]), [[false, 2]]);
});

test("the production API sends the ownership contract on every renewal and release", async () => {
  const { mockIPC, clearMocks } = await import("@tauri-apps/api/mocks");
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html>");
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  const calls: Array<[string, unknown]> = [];
  mockIPC((command, args) => {
    calls.push([command, args]);
    if (command === "agent_typing_document") return "41";
    return { sent: false, queuedTurns: [], pendingTurns: 0 };
  });
  try {
    const { setAgentTyping } = await import("../src/lib/api");
    await setAgentTyping("a", true);
    await setAgentTyping("a", true);
    await setAgentTyping("a", false);
    assert.deepEqual(calls, [
      ["agent_typing_document", {}],
      ["agent_set_typing", { agentId: "a", typing: true, document: "41", sequence: 1 }],
      ["agent_set_typing", { agentId: "a", typing: true, document: "41", sequence: 2 }],
      ["agent_set_typing", { agentId: "a", typing: false, document: "41", sequence: 3 }],
    ]);
  } finally {
    clearMocks();
    delete (globalThis as { __qmuxTypingReporter?: unknown }).__qmuxTypingReporter;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    dom.window.close();
  }
});
