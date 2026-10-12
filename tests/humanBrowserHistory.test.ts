import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const script = readFileSync(
  new URL("../src-tauri/src/human_browser_history.js", import.meta.url),
  "utf8",
);

type HistoryMethod = "pushState" | "replaceState";

function browser() {
  const dom = new JSDOM("", {
    url: "https://example.com/chart",
    runScripts: "outside-only",
  });
  const { window } = dom;
  let writes = 0;
  let failure: unknown;
  let duration = "10";
  const descriptors = new Map<HistoryMethod, PropertyDescriptor>();
  for (const method of ["pushState", "replaceState"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(window.History.prototype, method)!;
    const native = descriptor.value;
    const limited = function (this: History, ...args: unknown[]) {
      if (failure) throw failure;
      if (writes >= 100) {
        throw new window.DOMException(
          `Attempt to use history.${method}() more than 100 times per ${duration} seconds`,
          "SecurityError",
        );
      }
      const result = Reflect.apply(native, this, args);
      writes++;
      return result;
    };
    Object.defineProperty(window.History.prototype, method, { ...descriptor, value: limited });
    descriptors.set(method, { ...descriptor, value: limited });
  }
  window.eval(script);
  return {
    window,
    descriptors,
    failWith(error: unknown) { failure = error; },
    setDuration(value: string) { duration = value; },
    resetQuota() { writes = 0; },
    close: () => window.close(),
  };
}

test("chart URL updates survive WebKit's shared quota and resume after reset", () => {
  const b = browser();
  try {
    const { history, location } = b.window;
    for (let i = 0; i < 100; i++) {
      history[i % 2 ? "pushState" : "replaceState"]({ i }, "", `#forecast=${i}`);
    }
    const length = history.length;
    for (let i = 100; i < 250; i++) {
      assert.equal(history.replaceState({ i }, "", `#forecast=${i}`), undefined);
      assert.equal(history.pushState({ i }, "", `#route=${i}`), undefined);
    }
    assert.equal(location.hash, "#forecast=99");
    assert.deepEqual(history.state, { i: 99 });
    assert.equal(history.length, length);

    b.resetQuota();
    history.pushState({ route: "next" }, "", "/next");
    history.replaceState({ latest: true }, "", "#latest");
    assert.equal(location.href, "https://example.com/next#latest");
    assert.deepEqual(history.state, { latest: true });
    assert.equal(history.length, length + 1);
  } finally { b.close(); }
});

test("older WebKit frequency messages with fractional seconds are also handled", () => {
  const b = browser();
  try {
    b.setDuration("30.000000");
    for (let i = 0; i < 102; i++) b.window.history.replaceState(null, "", `#${i}`);
    assert.equal(b.window.location.hash, "#99");
  } finally { b.close(); }
});

test("other native failures propagate unchanged", () => {
  const b = browser();
  try {
    const { DOMException, history } = b.window;
    for (const error of [
      new DOMException("Blocked attempt to change session history URL", "SecurityError"),
      new DOMException("Attempt to use History API from a document that isn't fully active", "SecurityError"),
      new DOMException("Attempt to store more data than allowed using history.replaceState()", "QuotaExceededError"),
      new DOMException("The object could not be cloned.", "DataCloneError"),
      new DOMException("Attempt to use history.replaceState() more than 100 times per 10 seconds", "QuotaExceededError"),
      new Error("Attempt to use history.replaceState() more than 100 times per 10 seconds"),
      new TypeError("Illegal invocation"),
    ]) {
      b.failWith(error);
      for (const method of ["pushState", "replaceState"] as const) {
        assert.throws(() => history[method](null, "", "#test"), (caught) => caught === error);
      }
    }
  } finally { b.close(); }
});

test("normal History API validation, descriptors, and router wrappers are preserved", () => {
  const b = browser();
  try {
    const { History, history, location } = b.window;
    for (const method of ["pushState", "replaceState"] as const) {
      const before = b.descriptors.get(method)!;
      const after = Object.getOwnPropertyDescriptor(History.prototype, method)!;
      assert.equal(after.configurable, before.configurable);
      assert.equal(after.enumerable, before.enumerable);
      assert.equal(after.writable, before.writable);
      assert.equal(after.value.length, before.value.length);
      assert.equal(after.value.name, before.value.name);
      assert.throws(() => history[method](null, "", "https://elsewhere.example/"), { name: "SecurityError" });
      assert.throws(() => Reflect.apply(history[method], {}, [null, "", "#wrong"]), { name: "TypeError" });
    }
    // Next.js captures the original method and wraps it after document start.
    const original = history.replaceState.bind(history);
    history.replaceState = (data, unused, url) => original({ ...data, router: true }, unused, url);
    history.replaceState({ chart: 1 }, "", "#first");
    assert.deepEqual(history.state, { chart: 1, router: true });
    assert.equal(location.hash, "#first");
    assert.equal(history.length, 1);
    history.replaceState({ chart: 2 }, "");
    assert.deepEqual(history.state, { chart: 2, router: true });
    assert.equal(location.hash, "#first");
  } finally { b.close(); }
});
