import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement as h, StrictMode } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type {
  PublishingAuthPollResult,
  PublishingAuthStatus,
  PublishingDeviceAuthorization,
} from "../src/lib/publication";

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: "http://localhost",
  pretendToBeVisual: true,
});
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "DOMRect",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
]) {
  Object.defineProperty(globalThis, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
  });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  // Focus is handled by the real DialogRoot; these tests control only auth time.
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
});
const { createRoot } = await import("react-dom/client");
const { default: PublishDialog } = await import("../src/components/PublishDialog");
const container = document.getElementById("root")!;
let root = createRoot(container);
const realNow = Date.now;
let now = 0;
let timerId = 0;
const timers = new Map<number, { at: number; run: () => void }>();
window.setTimeout = ((run: () => void, delay = 0) => {
  const id = ++timerId;
  timers.set(id, { at: now + delay, run });
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = (id) => {
  if (typeof id === "number") timers.delete(id);
};

beforeEach(() => {
  now = 1_700_000_000_000;
  Date.now = () => now;
});
afterEach(async () => {
  await act(() => root.unmount());
  timers.clear();
  clearMocks();
  Date.now = realNow;
  root = createRoot(container);
});
after(async () => {
  await act(() => root.unmount());
  dom.window.close();
});

const target = {
  kindLabel: "research",
  initialTitle: "Findings",
  previewText: "preview",
  buildDraft: async () => {
    throw new Error("Publishing is outside this test");
  },
};
const disconnected: PublishingAuthStatus = { configured: true, connected: false };
const connected: PublishingAuthStatus = { configured: true, connected: true, login: "alice" };
const code = (name = "device", expiresIn = 120_000): PublishingDeviceAuthorization => ({
  deviceCode: name,
  userCode: name === "device" ? "ABCD-1234" : "NEXT-5678",
  verificationUri: "https://github.com/login/device",
  expiresAt: now + expiresIn,
  intervalSeconds: 1,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function backend(overrides: {
  status?: () => PublishingAuthStatus | Promise<PublishingAuthStatus>;
  begin?: () => PublishingDeviceAuthorization | Promise<PublishingDeviceAuthorization>;
  poll?: (deviceCode: string) => PublishingAuthPollResult | Promise<PublishingAuthPollResult>;
} = {}) {
  const calls: Array<{ command: string; deviceCode?: string; at: number }> = [];
  mockIPC((command, args) => {
    const deviceCode = (args as { deviceCode?: string })?.deviceCode;
    calls.push({ command, deviceCode, at: now });
    if (command === "publishing_auth_status") return overrides.status?.() ?? disconnected;
    if (command === "publishing_auth_begin") return overrides.begin?.() ?? code();
    if (command === "publishing_auth_poll") {
      return overrides.poll?.(deviceCode!) ?? { status: "pending", intervalSeconds: 1 };
    }
    if (command === "publishing_auth_disconnect") return disconnected;
    // open_external_url and native pointer claims are deliberately mocked.
    return undefined;
  });
  return {
    polls: () => calls.filter((call) => call.command === "publishing_auth_poll"),
    reads: () => calls.filter((call) => call.command === "publishing_auth_status"),
    begins: () => calls.filter((call) => call.command === "publishing_auth_begin"),
  };
}
const render = (open: boolean, strict = false) => act(() => {
  const dialog = h(PublishDialog, {
    target: open ? target : null,
    onClose: () => {},
    onPublished: () => {},
  });
  root.render(strict ? h(StrictMode, null, dialog) : dialog);
});
function button(label: string) {
  const match = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  assert.ok(match, `Expected ${label} button`);
  return match;
}
const click = (label: string) => act(() => button(label).click());
const text = () => document.body.textContent ?? "";
async function start() {
  await render(true);
  await click("Connect");
  assert.match(text(), /ABCD-1234/);
}
async function advance(ms: number) {
  const end = now + ms;
  let remaining = 100;
  while (true) {
    const next = [...timers]
      .filter(([, timer]) => timer.at <= end)
      .sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    assert.ok(remaining-- > 0, "Timer loop must be bounded");
    now = next[1].at;
    timers.delete(next[0]);
    await act(async () => {
      next[1].run();
    });
  }
  now = end;
}

test("the mounted dialog performs no OAuth polling while closed", async () => {
  const api = backend();
  await start();
  await render(false);
  await advance(10_000);
  assert.equal(api.polls().length, 0);
});

test("closing stops scheduling and reopening reuses the code and its remaining deadline", async () => {
  const api = backend();
  await start();
  await advance(400);
  await render(false);
  await advance(300);
  assert.equal(api.polls().length, 0);
  await render(true);
  assert.match(text(), /ABCD-1234/);
  assert.equal(api.begins().length, 1);
  await advance(299);
  assert.equal(api.polls().length, 0);
  await advance(1);
  assert.equal(api.polls().length, 1);
  await render(false);
  await advance(10_000);
  assert.equal(api.polls().length, 1, "No background polling while target is null");
});

for (const failStatus of [false, true]) {
  test(`resumed polling waits for the reopening status ${failStatus ? "failure" : "snapshot"}`, async () => {
    const status = deferred<PublishingAuthStatus>();
    let reads = 0;
    const api = backend({
      status: () => ++reads === 1 ? disconnected : status.promise,
      poll: () => ({ status: "connected", account: connected }),
    });
    await start();
    await render(false);
    await render(true);
    await advance(2_000);
    assert.equal(api.polls().length, 0, "An older status result must settle before a new poll starts");
    await act(async () => {
      if (failStatus) status.reject(new Error("stale status failure"));
      else status.resolve(disconnected);
    });
    await advance(0);
    assert.match(text(), /Connected as alice/);
    assert.doesNotMatch(text(), /stale status failure/);
    assert.equal(button("Publish now").disabled, false);
  });
}

test("a late successful poll reflects saved credentials after close and reopen", async () => {
  const poll = deferred<PublishingAuthPollResult>();
  let stored = disconnected;
  backend({ status: () => stored, poll: () => poll.promise });
  await start();
  await advance(1_000);
  await render(false);
  await render(true);
  stored = connected;
  await act(async () => poll.resolve({ status: "connected", account: connected }));
  assert.match(text(), /Connected as alice/);
  assert.equal(button("Publish now").disabled, false);
});

test("an old opening snapshot cannot overwrite a newer flow's successful poll", async () => {
  const old = deferred<PublishingAuthStatus>();
  let reads = 0;
  backend({
    status: () => ++reads === 1 ? old.promise : disconnected,
    poll: () => ({ status: "connected", account: connected }),
  });
  await render(true);
  await render(false);
  await render(true);
  await click("Connect");
  await advance(1_000);
  assert.match(text(), /Connected as alice/);
  await act(async () => old.resolve(disconnected));
  assert.match(text(), /Connected as alice/);
});

for (const failPoll of [false, true]) {
  test(`reopening reconciles a closed in-flight credential commit after poll ${failPoll ? "failure" : "success"}`, async () => {
    const poll = deferred<PublishingAuthPollResult>();
    let stored: PublishingAuthStatus = disconnected;
    const api = backend({ status: () => stored, poll: () => poll.promise });
    await start();
    await advance(1_000);
    await render(false);
    await render(true);
    await advance(2_000);
    assert.equal(api.polls().length, 1, "Never poll the same code twice concurrently");
    assert.equal(api.reads().length, 1, "Reopen must wait until the outstanding credential write settles");
    // The native command commits independently of delivery of its IPC result.
    stored = connected;
    await act(async () => {
      if (failPoll) poll.reject(new Error("lost IPC reply after commit"));
      else poll.resolve({ status: "connected", account: connected });
    });
    assert.equal(api.reads().length, 2, "Read the authoritative status after the write, even on failure");
    assert.match(text(), /Connected as alice/);
    assert.doesNotMatch(text(), /lost IPC reply/);
    await advance(10_000);
    assert.equal(api.polls().length, 1);
  });
}

test("repeated reopen while a pending poll is in flight keeps a single request and resumes its deadline", async () => {
  const poll = deferred<PublishingAuthPollResult>();
  const api = backend({ poll: () => poll.promise });
  await start();
  await advance(1_000);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await render(false);
    await render(true);
    await advance(1_000);
  }
  assert.equal(api.polls().length, 1);
  assert.equal(api.reads().length, 1);
  await act(async () => poll.resolve({ status: "pending", intervalSeconds: 10 }));
  assert.equal(api.reads().length, 2, "Retired opening waiters must not fetch status");
  await advance(9_999);
  assert.equal(api.polls().length, 1);
  await advance(1);
  assert.equal(api.polls().length, 2);
});

test("a pending response while closed updates the retained schedule without starting a timer", async () => {
  const poll = deferred<PublishingAuthPollResult>();
  const api = backend({ poll: () => poll.promise });
  await start();
  await advance(1_000);
  await render(false);
  await act(async () => poll.resolve({ status: "pending", intervalSeconds: 10 }));
  await advance(5_000);
  assert.equal(api.polls().length, 1);
  assert.equal(timers.size, 0);
  await render(true);
  await advance(4_999);
  assert.equal(api.polls().length, 1);
  await advance(1);
  assert.equal(api.polls().length, 2);
});

test("slow_down backoff survives reopen and subsequent shorter authorization_pending intervals", async () => {
  let polls = 0;
  const api = backend({
    poll: () => ({ status: "pending", intervalSeconds: ++polls === 1 ? 60 : 5 }),
  });
  await start();
  await advance(1_000);
  await advance(10_000);
  await render(false);
  await advance(10_000);
  await render(true);
  await advance(39_999);
  assert.equal(api.polls().length, 1);
  await advance(1);
  assert.equal(api.polls().length, 2);
  await advance(5_000);
  assert.equal(api.polls().length, 2, "A pending response must not erase prior slow_down backoff");
});

for (const closed of [false, true]) {
  test(`expiry discards the code ${closed ? "on reopen" : "before a long backoff ends"} without another poll`, async () => {
    const api = backend({
      begin: () => code("device", 2_000),
      poll: () => ({ status: "pending", intervalSeconds: 60 }),
    });
    await start();
    await advance(1_000);
    if (closed) await render(false);
    await advance(1_000);
    if (closed) await render(true);
    assert.doesNotMatch(text(), /ABCD-1234/);
    assert.equal(api.polls().length, 1);
    assert.equal(button("Connect").disabled, false);
  });
}

test("expiry does not retire a still-running poll or let a replacement flow overlap it", async () => {
  const poll = deferred<PublishingAuthPollResult>();
  let stored = disconnected;
  const api = backend({
    begin: () => code("device", 2_000),
    poll: () => poll.promise,
    status: () => stored,
  });
  await start();
  await advance(1_000);
  await render(false);
  await advance(2_000);
  await render(true);
  assert.equal(api.reads().length, 1);
  assert.equal(api.begins().length, 1);
  assert.match(text(), /ABCD-1234/);
  stored = connected;
  await act(async () => poll.resolve({ status: "connected", account: connected }));
  assert.match(text(), /Connected as alice/);
  assert.equal(api.begins().length, 1);
});

test("a failed flow can be replaced, and the replacement uses its own initial interval", async () => {
  let begins = 0;
  const api = backend({
    begin: () => code(++begins === 1 ? "device" : "next"),
    poll: (device) => {
      if (device === "device") throw new Error("GitHub authorization was denied.");
      return { status: "pending", intervalSeconds: 1 };
    },
  });
  await start();
  await advance(1_000);
  assert.match(text(), /GitHub authorization was denied/);
  await click("Connect");
  assert.match(text(), /NEXT-5678/);
  assert.doesNotMatch(text(), /GitHub authorization was denied/);
  await advance(1_000);
  assert.deepEqual(api.polls().map((call) => call.deviceCode), ["device", "next"]);
});

test("stale opening failure and finally cannot mutate the current opening", async () => {
  const old = deferred<PublishingAuthStatus>();
  const current = deferred<PublishingAuthStatus>();
  let reads = 0;
  backend({ status: () => ++reads === 1 ? old.promise : current.promise });
  await render(true);
  await render(false);
  await render(true);
  await act(async () => old.reject(new Error("stale opening failure")));
  assert.equal(button("Connect").disabled, true);
  assert.doesNotMatch(text(), /stale opening failure/);
  await act(async () => current.resolve(disconnected));
  assert.equal(button("Connect").disabled, false);
});

test("a begin result from a retired opening cannot replace the new flow", async () => {
  const old = deferred<PublishingDeviceAuthorization>();
  let begins = 0;
  const api = backend({ begin: () => ++begins === 1 ? old.promise : code("next") });
  await render(true);
  await click("Connect");
  // Prop-driven closure is exceptional; ordinary close controls are disabled.
  await render(false);
  await render(true);
  await click("Connect");
  assert.match(text(), /NEXT-5678/);
  await act(async () => old.resolve(code()));
  assert.match(text(), /NEXT-5678/);
  assert.doesNotMatch(text(), /ABCD-1234/);
  await advance(1_000);
  assert.deepEqual(api.polls().map((call) => call.deviceCode), ["next"]);
});

for (const failPoll of [false, true]) {
  test(`unmount discards a pending poll ${failPoll ? "rejection" : "completion"} and all scheduling`, async () => {
    const poll = deferred<PublishingAuthPollResult>();
    const api = backend({ poll: () => poll.promise });
    await start();
    await advance(1_000);
    await act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      if (failPoll) poll.reject(new Error("late failure"));
      else poll.resolve({ status: "pending", intervalSeconds: 1 });
    });
    await advance(10_000);
    assert.equal(api.polls().length, 1);
    assert.equal(timers.size, 0);
    assert.equal(text(), "");
  });
}

test("StrictMode effect replay has only one live status owner and poll timer", async () => {
  const api = backend();
  await render(true, true);
  await click("Connect");
  await advance(1_000);
  assert.equal(api.polls().length, 1);
  await render(false, true);
  await advance(10_000);
  assert.equal(api.polls().length, 1);
});
