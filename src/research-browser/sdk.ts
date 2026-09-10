import { resolveAppShortcut } from "../lib/appShortcuts";
import { BROWSER_PROTOCOL, browserHistoryDirection } from "./protocol";
import type { BrowserCall, BrowserSnapshot } from "./protocol";
import { createBrowserRpc } from "./rpc";

export interface ResearchBrowserSdk {
  version: 1;
  call: BrowserCall;
  getSnapshot: () => BrowserSnapshot;
  subscribe: (listener: (name: string, value: unknown) => void) => () => void;
}

/** Framework-independent entry point for trusted HTML, TSX, or other templates. */
export function connectResearchBrowser(): Promise<ResearchBrowserSdk> {
  if (window.parent === window)
    return Promise.reject(
      new Error("Open this view inside qmux’s Research Browser"),
    );
  const global = window as Window & {
    __qmuxBrowserSdk?: Promise<ResearchBrowserSdk>;
  };
  if (global.__qmuxBrowserSdk) return global.__qmuxBrowserSdk;
  global.__qmuxBrowserSdk = new Promise((resolve) => {
    let rpc: ReturnType<typeof createBrowserRpc> | undefined;
    let snapshot: BrowserSnapshot;
    const listeners = new Set<(name: string, value: unknown) => void>();
    const notify = (name: string, value: unknown) => {
      if (name === "snapshot") {
        snapshot = value as BrowserSnapshot;
        history.replaceState(
          null,
          "",
          `${location.pathname}${location.search}#${snapshot.route}`,
        );
      }
      for (const listener of listeners) listener(name, value);
    };
    const sdk: ResearchBrowserSdk = {
      version: 1,
      call: (method, ...args) => rpc!.call(method, ...args),
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const connect = (event: MessageEvent) => {
      if (
        event.source !== window.parent ||
        event.data?.protocol !== BROWSER_PROTOCOL ||
        event.data?.type !== "connect" ||
        !event.ports[0]
      )
        return;
      rpc?.dispose();
      snapshot = event.data.snapshot;
      rpc = createBrowserRpc(event.ports[0], notify);
      notify("snapshot", snapshot);
      notify("reconnected", null);
      resolve(sdk);
    };
    window.addEventListener("message", connect);
    // Retry also covers a parent's load event closing an early handshake.
    const ready = () =>
      window.parent.postMessage(
        { protocol: BROWSER_PROTOCOL, type: "ready", href: location.href },
        "*",
      );
    ready();
    const timer = setInterval(ready, 500);
    const onKey = (event: KeyboardEvent) => {
      if (!rpc || event.defaultPrevented || event.isComposing) return;
      const editable =
        event.target instanceof Element &&
        Boolean(
          event.target.closest(
            "input,textarea,select,[contenteditable='true']",
          ),
        );
      const input = {
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        editableTarget: editable,
      };
      const direction = browserHistoryDirection(input);
      if (direction) {
        event.preventDefault();
        void sdk
          .call(direction < 0 ? "navigation.back" : "navigation.forward")
          .catch(console.error);
      } else if (resolveAppShortcut(input)) {
        event.preventDefault();
        void sdk.call("ui.shortcut", input, event.repeat).catch(console.error);
      }
    };
    window.addEventListener("keydown", onKey);
    const onMouse = (event: MouseEvent) => {
      if (
        !rpc ||
        event.defaultPrevented ||
        (event.button !== 3 && event.button !== 4)
      )
        return;
      event.preventDefault();
      void sdk
        .call(event.button === 3 ? "navigation.back" : "navigation.forward")
        .catch(console.error);
    };
    window.addEventListener("mouseup", onMouse);
    const reportError = (event: ErrorEvent) => {
      if (rpc) void sdk.call("ui.reportError", event.message).catch(() => {});
    };
    const reportRejection = (event: PromiseRejectionEvent) => {
      if (rpc)
        void sdk.call("ui.reportError", String(event.reason)).catch(() => {});
    };
    window.addEventListener("error", reportError);
    window.addEventListener("unhandledrejection", reportRejection);
    window.addEventListener(
      "pagehide",
      () => {
        clearInterval(timer);
        window.removeEventListener("mouseup", onMouse);
        window.removeEventListener("error", reportError);
        window.removeEventListener("unhandledrejection", reportRejection);
        window.removeEventListener("message", connect);
        window.removeEventListener("keydown", onKey);
        rpc?.dispose();
      },
      { once: true },
    );
  });
  return global.__qmuxBrowserSdk;
}
