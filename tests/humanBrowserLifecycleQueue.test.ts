import assert from "node:assert/strict";
import test from "node:test";
import {
  HumanBrowserLifecycleQueue,
  HumanBrowserRetirements,
  openAfterBrowserHide,
  isHumanBrowserLifecycleBusy,
  retryHumanBrowserLifecycle,
} from "../src/lib/humanBrowserLifecycleQueue";

test("human browser lifecycle operations never overlap", async () => {
  const queue = new HumanBrowserLifecycleQueue();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  }, () => undefined);
  const second = queue.enqueue(async () => {
    events.push("second:start");
    events.push("second:end");
  }, () => undefined);

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("a rejected lifecycle operation does not poison later cleanup", async () => {
  const queue = new HumanBrowserLifecycleQueue();
  const failure = queue.enqueue(async () => {
    throw new Error("WebKit failed");
  }, () => undefined);
  const cleanup = queue.enqueue(async () => "destroyed", () => "cancelled");

  await assert.rejects(failure, /WebKit failed/);
  assert.equal(await cleanup, "destroyed");
});

test("busy lifecycle errors retry and then succeed", async () => {
  assert.equal(isHumanBrowserLifecycleBusy("human browser lifecycle is busy; retry the request"), true);
  assert.equal(isHumanBrowserLifecycleBusy(new Error("failed to hide")), false);

  let attempts = 0;
  const result = await retryHumanBrowserLifecycle(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error("human browser lifecycle is busy; retry the request");
    }
    return "hidden";
  });
  assert.equal(attempts, 3);
  assert.equal(result, "hidden");
});

test("non-busy lifecycle errors fail immediately", async () => {
  let attempts = 0;
  await assert.rejects(
    retryHumanBrowserLifecycle(async () => {
      attempts += 1;
      throw new Error("failed to hide the new human browser");
    }),
    /failed to hide the new human browser/,
  );
  assert.equal(attempts, 1);
});


test("cleanup interrupts a stalled queue and prevents deferred shows from running", async () => {
  const queue = new HumanBrowserLifecycleQueue();
  let release!: () => void;
  const first = queue.enqueue(() => new Promise<void>(resolve => { release = resolve; }), () => undefined);
  let obsoleteRan = false;
  const obsolete = queue.enqueue(async () => { obsoleteRan = true; return "shown"; }, () => "cancelled");
  await Promise.resolve();
  queue.interrupt();
  assert.equal(await queue.enqueue(async () => "reopened", () => "cancelled"), "reopened");
  release();
  await first;
  assert.equal(await obsolete, "cancelled");
  assert.equal(obsoleteRan, false);
  assert.equal(await queue.enqueue(async () => "next", () => "cancelled"), "next");
});

test("failed retirement retries without another React state change", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const retirements = new HumanBrowserRetirements();
  let attempts = 0;
  await assert.rejects(retirements.retire("a", async () => {
    if (++attempts === 1) throw new Error("native close failed");
  }), /native close failed/);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(attempts, 2);
  t.mock.timers.tick(10000);
  assert.equal(attempts, 2);
});

test("reopening cancels retirement retries, including an in-flight failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const retirements = new HumanBrowserRetirements();
  let reject!: (error: Error) => void;
  let attempts = 0;
  const retiring = retirements.retire("a", () => {
    attempts += 1;
    return new Promise<void>((_, fail) => { reject = fail; });
  });
  retirements.cancel("a");
  reject(new Error("late failure"));
  await assert.rejects(retiring, /late failure/);
  t.mock.timers.tick(10000);
  assert.equal(attempts, 1);
});


test("external launch waits for native hiding and is cancelled by a newer overlay", async () => {
  let acknowledge!: (applied: boolean) => void;
  let opened = 0;
  let current = true;
  const input = {
    hide: () => new Promise<boolean>(resolve => { acknowledge = resolve; }),
    isCurrent: () => current,
    open: async () => { opened += 1; },
    restore: () => assert.fail("unexpected restore"),
  };
  const first = openAfterBrowserHide(input);
  assert.equal(opened, 0);
  acknowledge(true);
  await first;
  assert.equal(opened, 1);
  const second = openAfterBrowserHide(input);
  current = false;
  acknowledge(true);
  await second;
  assert.equal(opened, 1);
});

test("external launch failure restores only the original overlay", async () => {
  let current = true;
  let restored = 0;
  const input = {
    hide: async () => true,
    isCurrent: () => current,
    open: async () => { throw new Error("launch failed"); },
    restore: () => { restored += 1; },
  };
  await assert.rejects(openAfterBrowserHide(input), /launch failed/);
  assert.equal(restored, 1);
  input.open = async () => { current = false; throw new Error("late failure"); };
  await assert.rejects(openAfterBrowserHide(input), /late failure/);
  assert.equal(restored, 1);
});
