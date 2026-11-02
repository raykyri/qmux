import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h, StrictMode } from "react";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

// Exercise the actual component, React effects and Tauri wrappers. Only IPC,
// window events and animation frames are controlled by this harness.
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost" });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "localStorage", "sessionStorage", "navigator"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
let frames: FrameRequestCallback[] = [];
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
  cancelAnimationFrame: () => {},
});
const { createRoot } = await import("react-dom/client");
const { emit } = await import("@tauri-apps/api/event");
const { default: Launcher } = await import("../src/components/GlobalTaskLauncher");
const container = document.getElementById("root")!;
let root = createRoot(container);

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Request = ReturnType<typeof deferred> & { args: Record<string, unknown> };
type Subscription = { event: string; handler: number; ack: ReturnType<typeof deferred>; removed: boolean };
let calls = new Map<string, Request[]>();
let subscriptions: Subscription[] = [];
let deferRegistrations = false;
let deferConfig = false;
let hideCount = 0;

function requests(command: string): Request[] {
  return calls.get(command) ?? [];
}

beforeEach(() => {
  calls = new Map();
  subscriptions = [];
  frames = [];
  deferRegistrations = false;
  deferConfig = false;
  hideCount = 0;
  localStorage.clear();
  sessionStorage.clear();
  mockWindows("global-task-launcher");
  mockIPC((command, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    if (command === "plugin:event|listen") {
      const subscription: Subscription = {
        event: args.event as string,
        handler: args.handler as number,
        ack: deferred(),
        removed: false,
      };
      subscriptions.push(subscription);
      if (!deferRegistrations) subscription.ack.resolve(subscription.handler);
      return subscription.ack.promise;
    }
    if (command === "plugin:event|unlisten") {
      const subscription = subscriptions.find((entry) => entry.handler === args.eventId);
      assert.ok(subscription, `unknown subscription ${String(args.eventId)}`);
      subscription.removed = true;
      return;
    }
    if (command === "plugin:event|emit") {
      for (const subscription of subscriptions.slice()) {
        if (subscription.removed || subscription.event !== args.event) continue;
        window.__TAURI_INTERNALS__.runCallback(subscription.handler, {
          event: args.event, id: subscription.handler, payload: args.payload,
        });
      }
      return;
    }
    if (command === "plugin:window|hide") { hideCount++; return; }
    if (command === "get_runtime_config" && !deferConfig) return { adapters: [], remotes: [] };
    if (command === "interface_draft_get") return null;
    if (command === "interface_draft_set") return;
    if (command === "list_turns") return [];
    if (["get_runtime_config", "list_panes", "list_agents", "list_groups", "list_shell_agent_jobs", "list_agent_turn_queue", "agent_submit_turn", "agent_unpause"].includes(command)) {
      const request = { ...deferred(), args };
      calls.set(command, [...requests(command), request]);
      return request.promise;
    }
    throw new Error(`unexpected IPC ${command}`);
  });
});

afterEach(async () => {
  await act(() => root.unmount());
  // Late registration acknowledgments must release every already-attached
  // listener, including the SDK's sequential focus/blur setup on baseline.
  for (let pass = 0; pass < 3; pass++) {
    await act(() => { subscriptions.forEach((entry) => entry.ack.resolve(entry.handler)); });
  }
  root = createRoot(container);
});
after(async () => { await act(() => root.unmount()); dom.window.close(); });

async function mount(strict = false) {
  await act(() => root.render(strict ? h(StrictMode, null, h(Launcher)) : h(Launcher)));
}
async function focus() { await act(() => emit("tauri://focus", true)); }
async function blur() { await act(() => emit("tauri://blur", false)); }
async function eventRefresh() {
  await act(() => emit("qmux-event", { type: "agent-updated" }));
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
}
const coreLists = ["list_panes", "list_agents", "list_groups", "list_shell_agent_jobs"];

// Lists and per-agent queues are separate native calls. Let a test hold either
// phase independently, instead of replacing the production refresh algorithm.
async function lists(index: number, title: string, ids = ["a"], optionalFailure = false, agentFields: Record<string, unknown> = {}) {
  const queueStart = requests("list_agent_turn_queue").length;
  await act(() => {
    requests("list_panes")[index].resolve(ids.map((id) => ({
      id: `p-${id}`, title: `${title} ${id}`, kind: "agent", groupId: "g", cwd: "/tmp", status: "running",
    })));
    requests("list_agents")[index].resolve(ids.map((id, order) => ({
      id, paneId: `p-${id}`, groupId: "g", adapter: "claude", status: "idle", createdAt: order, ...agentFields,
    })));
    requests("list_groups")[index].resolve([{ id: "g", name: `${title} group` }]);
    if (optionalFailure) requests("list_shell_agent_jobs")[index].reject(new Error("optional jobs failed"));
    else requests("list_shell_agent_jobs")[index].resolve([]);
  });
  return requests("list_agent_turn_queue").slice(queueStart);
}
async function queues(pending: Request[], label = "", fail = false) {
  await act(() => {
    for (const request of pending) {
      if (fail) request.reject(new Error("optional queue failed"));
      else request.resolve(label ? [{ text: `${label} ${request.args.agentId}` }] : []);
    }
  });
}
async function snapshot(index: number, title: string, ids = ["a"]) {
  await queues(await lists(index, title, ids));
}
async function failLists(index: number, message: string) {
  await act(() => {
    coreLists.forEach((command) => {
      if (command === "list_agents") requests(command)[index].reject(new Error(message));
      else requests(command)[index].resolve([]);
    });
  });
}
function selected() { return container.querySelector('[role="option"][aria-selected="true"]')?.id; }
function titleText() { return [...container.querySelectorAll(".pane-tab-title")].map((node) => node.textContent); }
function alertText() { return container.querySelector('[role="alert"]')?.textContent ?? null; }
async function pick(id: string) {
  await act(() => (document.getElementById(`global-task-launcher-option-${id}`) as HTMLButtonElement).click());
}
async function type(text: string) {
  const input = container.querySelector("textarea")!;
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("a late prewarm queue cannot replace a newer focus snapshot or selection", async () => {
  await mount();
  const old = await lists(0, "Old", ["a"]);
  await focus();
  await snapshot(1, "Fresh", ["a", "b"]);
  await pick("b");
  await queues(old, "old queued");
  assert.deepEqual(titleText(), ["Fresh a", "Fresh b"]);
  assert.equal(selected(), "global-task-launcher-option-b");
  assert.doesNotMatch(container.textContent!, /old queued/);
});

test("reversed focus and backend-event list responses keep the newest snapshot", async () => {
  await mount();
  await snapshot(0, "Prewarm");
  await focus();
  await eventRefresh();
  await snapshot(2, "Event", ["b"]);
  await snapshot(1, "Focus", ["a"]);
  assert.deepEqual(titleText(), ["Event b"]);
  assert.equal(selected(), "global-task-launcher-option-b");
});

test("stale rejection does not publish an error or end a newer initial load", async () => {
  await mount();
  await focus();
  await failLists(0, "stale prewarm failure");
  assert.equal(alertText(), null);
  assert.equal(container.querySelector("textarea")!.placeholder, "Loading agent tabs…");
  await snapshot(1, "Recovered");
  assert.deepEqual(titleText(), ["Recovered a"]);
});

test("stale success cannot erase the latest request failure; retry clears it", async () => {
  await mount();
  const old = await lists(0, "Old");
  await focus();
  await failLists(1, "latest failed");
  await queues(old);
  assert.equal(alertText(), "latest failed");
  assert.deepEqual(titleText(), []);
  await eventRefresh();
  await snapshot(2, "Retry");
  assert.equal(alertText(), null);
  assert.deepEqual(titleText(), ["Retry a"]);
});

test("a current core-list partial failure keeps the last complete targets and retries", async () => {
  await mount();
  await snapshot(0, "Known", ["a", "b"]);
  await focus();
  await pick("b");
  await failLists(1, "agents unavailable");
  assert.deepEqual(titleText(), ["Known a", "Known b"]);
  assert.equal(selected(), "global-task-launcher-option-b");
  assert.equal(alertText(), "agents unavailable");
  await eventRefresh();
  await snapshot(2, "Retry", ["a", "b"]);
  assert.equal(alertText(), null);
  assert.equal(selected(), "global-task-launcher-option-b");
});

test("optional shell-job and queue failure retain the existing empty fallback", async () => {
  await mount();
  await queues(await lists(0, "Usable", ["a"], true), "", true);
  assert.deepEqual(titleText(), ["Usable a"]);
  assert.equal(alertText(), null);
  assert.equal(container.querySelector("textarea")!.disabled, false);
});

test("the newest response preserves a user selection made while it was pending", async () => {
  await mount();
  await snapshot(0, "Initial", ["a", "b"]);
  await focus();
  await pick("b");
  await snapshot(1, "Updated", ["a", "b"]);
  assert.equal(selected(), "global-task-launcher-option-b");
  await eventRefresh();
  await snapshot(2, "Remaining", ["a"]);
  assert.equal(selected(), "global-task-launcher-option-a");
});

test("blur revokes pending publication even before another summon starts", async () => {
  await mount();
  await snapshot(0, "Initial");
  await focus();
  const old = await lists(1, "Hidden");
  await blur();
  await queues(old);
  assert.deepEqual(titleText(), ["Initial a"]);
  assert.equal(hideCount, 1);
});

test("A → B → A across summons cannot revive the first A refresh", async () => {
  await mount();
  await snapshot(0, "Initial", ["a", "b"]);
  await focus();
  const firstA = await lists(1, "First A", ["a"]);
  await blur();
  await focus();
  await snapshot(2, "B summon", ["a", "b"]);
  await pick("b");
  await blur();
  await focus();
  await snapshot(3, "Last A", ["a", "b"]);
  await pick("a");
  await queues(firstA);
  assert.deepEqual(titleText(), ["Last A a", "Last A b"]);
  assert.equal(selected(), "global-task-launcher-option-a");
});

test("late refresh success and failure cannot clear or replace a newer send error", async () => {
  await mount();
  await snapshot(0, "Initial");
  await focus();
  const refresh = await lists(1, "Updated");
  await type("Send this");
  const send = [...container.querySelectorAll("button")].find((button) => button.querySelector("span")?.textContent === "Send")!;
  await act(() => send.click());
  await act(() => requests("agent_submit_turn")[0].reject(new Error("delivery failed")));
  assert.equal(alertText(), "delivery failed");
  await queues(refresh);
  assert.equal(alertText(), "delivery failed");
  await eventRefresh();
  await failLists(2, "refresh failed too");
  assert.equal(alertText(), "delivery failed");
  await blur();
  await focus();
  await snapshot(3, "Next summon");
  assert.equal(alertText(), null);
});

test("hidden backend events and a debounce cancelled by blur do not fetch", async () => {
  await mount();
  await snapshot(0, "Initial");
  await eventRefresh();
  assert.equal(requests("list_panes").length, 1);
  await focus();
  await snapshot(1, "Focused");
  await act(() => emit("qmux-event", {}));
  await blur();
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
  assert.equal(requests("list_panes").length, 2);
});

test("a disposed listener cannot start work before its registration promise resolves", async () => {
  deferRegistrations = true;
  await mount();
  await snapshot(0, "Initial");
  await act(() => root.unmount());
  root = createRoot(container);
  await focus();
  assert.equal(requests("list_panes").length, 1);
  await eventRefresh();
  assert.equal(requests("list_panes").length, 1);
});

test("StrictMode ignores its disposed setup even while both focus listeners are attached", async () => {
  deferRegistrations = true;
  await mount(true);
  // The two setups may both start their config read, but disposed work should
  // not progress to list calls. Count the active phase instead of assuming it.
  const before = requests("list_panes").length;
  await focus();
  assert.equal(requests("list_panes").length, before + 1);
  await snapshot(before, "Current");
  for (let index = 0; index < before; index++) await snapshot(index, "Disposed");
  assert.deepEqual(titleText(), ["Current a"]);
});

test("deferred focus frames from an old summon cannot focus the reopened filter", async () => {
  await mount();
  await snapshot(0, "Initial", ["a", "b"]);
  await focus();
  const oldFrames = frames.splice(0);
  await blur();
  await focus();
  frames = [];
  const filter = container.querySelector("input")!;
  filter.focus();
  await act(() => oldFrames.forEach((callback) => callback(0)));
  assert.equal(document.activeElement === filter, true);
});

test("unmount and remount cannot admit the previous instance's list result", async () => {
  await mount();
  const old = await lists(0, "Old mount");
  await act(() => root.unmount());
  root = createRoot(container);
  await mount();
  await snapshot(1, "New mount");
  await queues(old);
  assert.deepEqual(titleText(), ["New mount a"]);
});

test("a stale config failure cannot erase the successful cache or continue to lists", async () => {
  deferConfig = true;
  await mount();
  await focus();
  await act(() => requests("get_runtime_config")[1].resolve({ adapters: [], remotes: [] }));
  await snapshot(0, "Fresh");
  await act(() => requests("get_runtime_config")[0].reject(new Error("old config failed")));
  assert.equal(requests("list_panes").length, 1);
  await eventRefresh();
  assert.equal(requests("get_runtime_config").length, 2);
  await snapshot(1, "Cached");
});

test("late successful listener registrations are each released after disposal", async () => {
  deferRegistrations = true;
  await mount();
  await act(() => root.unmount());
  root = createRoot(container);
  for (let pass = 0; pass < 3; pass++) {
    await act(() => { subscriptions.forEach((entry) => entry.ack.resolve(entry.handler)); });
  }
  assert.equal(subscriptions.length, 3);
  assert.equal(subscriptions.every((entry) => entry.removed), true);
  const before = requests("list_panes").length;
  await focus();
  await eventRefresh();
  assert.equal(requests("list_panes").length, before);
});

test("a failed blur registration does not strand the successful focus subscription", async (context) => {
  context.mock.method(console, "warn", () => {});
  deferRegistrations = true;
  await mount();
  const focused = subscriptions.find((entry) => entry.event === "tauri://focus")!;
  await act(() => focused.ack.resolve(focused.handler));
  const blurred = subscriptions.find((entry) => entry.event === "tauri://blur")!;
  await act(() => blurred.ack.reject(new Error("blur registration failed")));
  await act(() => root.unmount());
  root = createRoot(container);
  assert.equal(focused.removed, true);
  // This tests successful subscriptions' ownership. The SDK retains the
  // callback allocated for a rejected listen; this candidate does not replace
  // the SDK's low-level callback allocation, nor claim to fix that leak.
});

test("an old unpause completion cannot start a refresh in a later summon", async () => {
  await mount();
  await queues(await lists(0, "Paused", ["a"], false, { paused: true }));
  await focus();
  await queues(await lists(1, "Paused", ["a"], false, { paused: true }));
  const unpause = [...container.querySelectorAll("button")].find((button) => button.textContent === "Unpause")!;
  await act(() => unpause.click());
  await blur();
  await focus();
  await snapshot(2, "Reopened");
  await act(() => requests("agent_unpause")[0].resolve({}));
  assert.equal(requests("list_panes").length, 3);
  assert.deepEqual(titleText(), ["Reopened a"]);
});
