import type { AppShortcutInput } from "../lib/appShortcuts";
import type * as api from "../lib/api";
import type { RecentActivityPaneProps } from "../components/research/JournalPane";

export const BROWSER_PROTOCOL = "qmux.research-browser.v1";
export type ActivityState = Pick<
  RecentActivityPaneProps,
  | "items"
  | "researchTrees"
  | "nextCursor"
  | "loadingOlder"
  | "olderError"
  | "pendingUndo"
>;
export interface BrowserSnapshot {
  activity: ActivityState;
  route: string;
  viewState: Record<string, unknown>;
  theme: { attributes: Record<string, string>; style: string };
}

/** V1 deliberately exposes research services, never arbitrary native invoke. */
export interface BrowserMethods {
  "workspaces.list": typeof api.listGroups;
  "workspaces.ensureDefault": typeof api.ensureDefaultResearchWorkspace;
  "research.list": typeof api.listResearchTrees;
  "research.activity": typeof api.listRecentActivity;
  "research.folders": typeof api.listResearchFolders;
  "research.getTree": typeof api.getResearchTree;
  "research.getNodeContent": typeof api.getResearchNodeContent;
  "research.create": typeof api.createResearchTree;
  "research.createDocument": typeof api.createResearchDocument;
  "research.updateDocument": typeof api.updateResearchDocument;
  "research.fork": typeof api.forkResearchNode;
  "research.retry": typeof api.retryResearchNode;
  "research.cancel": typeof api.cancelResearchNode;
  "research.renameTree": typeof api.renameResearchTree;
  "research.renameNode": typeof api.renameResearchNode;
  "research.createHighlight": typeof api.createResearchHighlight;
  "research.removeHighlight": typeof api.removeResearchHighlight;
  "research.markViewed": typeof api.markResearchTreeViewed;
  "journal.add": (text: string) => void;
  "journal.remove": (id: string) => void;
  "journal.retry": (id: string) => void;
  "journal.undo": () => void;
  "journal.dismissUndo": () => void;
  "activity.loadOlder": () => void;
  "navigation.openDocument": (treeId: string, nodeId: string) => Promise<void>;
  "navigation.openTerminal": (paneId: string) => void;
  "navigation.go": (route: string) => void;
  "navigation.back": () => void;
  "navigation.forward": () => void;
  "ui.openExternalUrl": typeof api.openExternalUrl;
  "ui.writeClipboardText": (text: string) => Promise<void>;
  "ui.reportError": (message: string) => void;
  "ui.shortcut": (input: AppShortcutInput, repeat: boolean) => void;
  "viewState.save": (key: string, value: unknown) => void;
}

export type BrowserHandlers = {
  [K in keyof BrowserMethods]: BrowserMethods[K];
};
export type BrowserCall = <K extends keyof BrowserMethods>(
  method: K,
  ...args: Parameters<BrowserMethods[K]>
) => Promise<Awaited<ReturnType<BrowserMethods[K]>>>;

export function browserRoute(route: string): string {
  if (typeof route !== "string" || route.length > 2048)
    throw new Error("Invalid Research Browser route");
  // Reject malformed escapes now rather than crashing a template's route parser.
  decodeURIComponent(route);
  if (
    route === "/activity" ||
    /^\/research\/[^/?#]+(?:\/node\/[^/?#]+)?$/.test(route)
  )
    return route;
  throw new Error("Unsupported Research Browser route");
}

export function trustedBrowserUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error("Use an HTTP URL on localhost or 127.0.0.1");
  }
  url.hash = "";
  return url.href;
}

export function matchesBrowserDocument(
  actual: string,
  expected: string,
): boolean {
  try {
    const a = new URL(actual),
      b = new URL(expected);
    a.hash = "";
    b.hash = "";
    return a.href === b.href;
  } catch {
    return false;
  }
}

/** Shared by the parent chrome and iframe so focus does not change history keys. */
export function browserHistoryDirection(
  input: AppShortcutInput,
): -1 | 1 | null {
  if (input.editableTarget || input.shiftKey) return null;
  if ((input.metaKey || input.ctrlKey) && !input.altKey) {
    if (input.key === "[") return -1;
    if (input.key === "]") return 1;
  }
  if (input.altKey && !input.metaKey && !input.ctrlKey) {
    if (input.key === "ArrowLeft") return -1;
    if (input.key === "ArrowRight") return 1;
  }
  return null;
}
