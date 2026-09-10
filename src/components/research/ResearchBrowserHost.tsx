import { useEffect, useRef, useState } from "react";
import {
  resolveAppShortcut,
  type AppShortcutCommand,
} from "../../lib/appShortcuts";
import { isEditableTarget } from "../../lib/appHelpers";
import * as api from "../../lib/api";
import { writeClipboardText } from "../../lib/clipboard";
import type { RecentActivityPaneProps } from "./JournalPane";
import { ResearchDocumentFrame } from "./ResearchDocumentChrome";
import {
  BROWSER_PROTOCOL,
  browserHistoryDirection,
  browserRoute,
  matchesBrowserDocument,
  trustedBrowserUrl,
} from "../../research-browser/protocol";
import type {
  BrowserHandlers,
  BrowserSnapshot,
} from "../../research-browser/protocol";
import { serveBrowserRpc } from "../../research-browser/rpc";
import "../../research-browser/host.css";

const SOURCE_KEY = "qmux.research-browser.source.v1";
const STATE_KEY = "qmux.research-browser.state.v1";
function storedSource() {
  try {
    const value = localStorage.getItem(SOURCE_KEY);
    return value ? trustedBrowserUrl(value) : "";
  } catch {
    return "";
  }
}
function storedState(): {
  routes: string[];
  index: number;
  values: Record<string, unknown>;
} {
  try {
    const value = JSON.parse(sessionStorage.getItem(STATE_KEY) ?? "null");
    if (
      value &&
      Array.isArray(value.routes) &&
      value.routes.length &&
      value.routes.every((route: string) => browserRoute(route)) &&
      Number.isInteger(value.index) &&
      value.index >= 0 &&
      value.index < value.routes.length &&
      value.values &&
      typeof value.values === "object"
    )
      return value;
  } catch {
    /* Restore a safe initial route after corrupt/stale state. */
  }
  return { routes: ["/activity"], index: 0, values: {} };
}

export default function ResearchBrowserHost(
  props: RecentActivityPaneProps & {
    onOpenPane: (paneId: string) => void;
    onAppShortcut: (command: AppShortcutCommand, repeat: boolean) => void;
  },
) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const [source, setSource] = useState(storedSource);
  const [sourceDraft, setSourceDraft] = useState(source);
  const [configure, setConfigure] = useState(false);
  const [reload, setReload] = useState(0);
  const [status, setStatus] = useState("Connecting to Research Browser…");
  const [state, setState] = useState(storedState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const connectionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const closeRef = useRef<() => void>(() => {});
  const snapshotRef = useRef<() => BrowserSnapshot>(() => {
    throw new Error("Not initialized");
  });
  const src =
    source || new URL("research-browser.html", window.location.href).href;

  snapshotRef.current = () => {
    const p = propsRef.current,
      current = stateRef.current;
    const root = document.documentElement;
    return {
      activity: {
        items: p.items,
        researchTrees: p.researchTrees,
        nextCursor: p.nextCursor,
        loadingOlder: p.loadingOlder,
        olderError: p.olderError,
        pendingUndo: p.pendingUndo,
      },
      route: current.routes[current.index],
      viewState: current.values,
      theme: {
        attributes: Object.fromEntries(
          Array.from(root.attributes)
            .filter((a) => a.name.startsWith("data-"))
            .map((a) => [a.name, a.value]),
        ),
        style: root.style.cssText,
      },
    };
  };
  const emit = (name: string, value: unknown) =>
    portRef.current?.postMessage({ type: "event", name, value });
  const save = (next: typeof state) => {
    // Synchronous ref update keeps multiple calls in one channel turn ordered.
    stateRef.current = next;
    setState(next);
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify(next));
    } catch {
      /* In-memory restoration remains available. */
    }
  };
  const navigate = (route: string) => {
    browserRoute(route);
    const current = stateRef.current;
    if (current.routes[current.index] === route) return;
    const routes = [...current.routes.slice(0, current.index + 1), route].slice(
      -100,
    );
    save({ ...current, routes, index: routes.length - 1 });
  };
  const move = (delta: number) => {
    const current = stateRef.current;
    const index = current.index + delta;
    if (index >= 0 && index < current.routes.length)
      save({ ...current, index });
    else if (delta < 0) propsRef.current.onBack?.();
    else propsRef.current.onForward?.();
  };
  const historyMoveRef = useRef(move);
  historyMoveRef.current = move;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const direction = browserHistoryDirection({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        editableTarget: isEditableTarget(event.target),
      });
      if (direction) {
        event.preventDefault();
        historyMoveRef.current(direction);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const beginConnection = () => {
    closeRef.current();
    portRef.current = null;
    clearTimeout(connectionTimerRef.current);
    setStatus("Connecting to Research Browser…");
    connectionTimerRef.current = setTimeout(
      () =>
        setStatus(
          "Research Browser has not connected. Check the server or restore the built-in view.",
        ),
      8000,
    );
  };
  const handlersRef = useRef<BrowserHandlers>(null!);
  handlersRef.current = {
    "workspaces.list": async () =>
      (await api.listGroups()).filter((group) => group.scope === "research"),
    "workspaces.ensureDefault": api.ensureDefaultResearchWorkspace,
    "research.list": api.listResearchTrees,
    "research.activity": api.listRecentActivity,
    "research.folders": api.listResearchFolders,
    "research.getTree": api.getResearchTree,
    "research.getNodeContent": api.getResearchNodeContent,
    "research.create": api.createResearchTree,
    "research.createDocument": api.createResearchDocument,
    "research.updateDocument": api.updateResearchDocument,
    "research.fork": api.forkResearchNode,
    "research.retry": api.retryResearchNode,
    "research.cancel": api.cancelResearchNode,
    "research.renameTree": api.renameResearchTree,
    "research.renameNode": api.renameResearchNode,
    "research.createHighlight": api.createResearchHighlight,
    "research.removeHighlight": api.removeResearchHighlight,
    "research.markViewed": api.markResearchTreeViewed,
    "journal.add": (text) => propsRef.current.onAddEntry(text),
    "journal.remove": (id) => propsRef.current.onRemoveEntry(id),
    "journal.retry": (id) => propsRef.current.onRetryTweet(id),
    "journal.undo": () => propsRef.current.onUndoRemove(),
    "journal.dismissUndo": () => propsRef.current.onDismissUndo(),
    "activity.loadOlder": () => propsRef.current.onLoadOlder(),
    "navigation.openDocument": async (treeId, nodeId) => {
      const { node } = await api.getResearchNodeContent(nodeId);
      if (node.treeId !== treeId)
        throw new Error("Node does not belong to this research");
      propsRef.current.onOpenResearchQuery({
        ...node,
        nodeId: node.id,
        inline: Boolean(node.inline),
      });
    },
    "navigation.openTerminal": (paneId) => propsRef.current.onOpenPane(paneId),
    "navigation.go": navigate,
    "navigation.back": () => move(-1),
    "navigation.forward": () => move(1),
    "ui.openExternalUrl": api.openExternalUrl,
    "ui.writeClipboardText": writeClipboardText,
    "ui.reportError": (message) =>
      setStatus(`Research Browser: ${String(message).slice(0, 2000)}`),
    "ui.shortcut": (input, repeat) => {
      const command = resolveAppShortcut(input);
      if (command) propsRef.current.onAppShortcut(command, repeat);
    },
    "viewState.save": (key, value) => {
      if (typeof key !== "string" || key.length > 256)
        throw new Error("Invalid view state key");
      save({
        ...stateRef.current,
        values: { ...stateRef.current.values, [key]: value },
      });
    },
  };

  useEffect(() => {
    emit("snapshot", snapshotRef.current());
  }, [props, state]);
  useEffect(() => {
    const observer = new MutationObserver(() =>
      emit("snapshot", snapshotRef.current()),
    );
    observer.observe(document.documentElement, { attributes: true });
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void api
      .listenToEvents((event) => {
        if (event.type.startsWith("research.")) emit("research.changed", event);
      })
      .then((stop) => {
        if (stopped) stop();
        else unlisten = stop;
      })
      .catch((error) => setStatus(String(error)));
    return () => {
      stopped = true;
      observer.disconnect();
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    beginConnection();
    const connect = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        event.origin !==
          (source ? new URL(src).origin : window.location.origin) ||
        event.data?.protocol !== BROWSER_PROTOCOL ||
        event.data?.type !== "ready" ||
        !matchesBrowserDocument(event.data.href, src)
      )
        return;
      if (portRef.current) return;
      const channel = new MessageChannel();
      portRef.current = channel.port1;
      closeRef.current = serveBrowserRpc(
        channel.port1,
        () => handlersRef.current,
      );
      frameRef.current!.contentWindow!.postMessage(
        {
          protocol: BROWSER_PROTOCOL,
          type: "connect",
          snapshot: snapshotRef.current(),
        },
        event.origin === "null" ? "*" : event.origin,
        [channel.port2],
      );
      clearTimeout(connectionTimerRef.current);
      setStatus("");
    };
    window.addEventListener("message", connect);
    return () => {
      clearTimeout(connectionTimerRef.current);
      window.removeEventListener("message", connect);
      closeRef.current();
      portRef.current = null;
    };
  }, [src, reload]);

  const chooseSource = (value: string) => {
    try {
      const next = value.trim() ? trustedBrowserUrl(value.trim()) : "";
      localStorage.setItem(SOURCE_KEY, next);
      setSource(next);
      setSourceDraft(next);
      setConfigure(false);
      setReload((n) => n + 1);
    } catch (error) {
      setStatus(String(error));
    }
  };
  return (
    <ResearchDocumentFrame
      title="Research Browser"
      canGoBack={state.index > 0 || props.canGoBack}
      canGoForward={state.index < state.routes.length - 1 || props.canGoForward}
      onBack={() => move(-1)}
      onForward={() => move(1)}
      headerActions={
        <div className="research-browser-actions">
          <button
            className="control-button"
            onClick={() => navigate("/activity")}
          >
            Activity
          </button>
          <button
            className="control-button"
            onClick={() => setReload((n) => n + 1)}
          >
            Reload
          </button>
          <button
            className="control-button"
            onClick={() => setConfigure((v) => !v)}
          >
            View source
          </button>
          {source && (
            <button className="control-button" onClick={() => chooseSource("")}>
              Restore built-in view
            </button>
          )}
        </div>
      }
    >
      <div className="research-browser-host-body">
        {configure && (
          <form
            className="research-browser-source"
            onSubmit={(event) => {
              event.preventDefault();
              chooseSource(sourceDraft);
            }}
          >
            <label>
              Trusted view URL
              <input
                value={sourceDraft}
                onChange={(event) => setSourceDraft(event.target.value)}
                placeholder="http://127.0.0.1:1421/research-browser.html"
              />
            </label>
            <span>
              This view can read and modify your research through the qmux SDK.
            </span>
            <button className="control-button" type="submit">
              Load view
            </button>
            <button
              className="control-button"
              type="button"
              onClick={() => chooseSource("")}
            >
              Use built-in
            </button>
          </form>
        )}
        {status && (
          <div className="research-browser-status" role="status">
            {status}
          </div>
        )}
        <iframe
          key={`${src}:${reload}`}
          ref={frameRef}
          className="research-browser-frame"
          title="Research Browser content"
          src={src}
          onLoad={beginConnection}
        />
      </div>
    </ResearchDocumentFrame>
  );
}
