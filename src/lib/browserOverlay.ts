import type { BrowserOverlayState, BrowserPreviewScrollPosition } from "../appTypes";
import { displayPathsReferToSameDirectory } from "./appHelpers";
import { pathFromFileServerUrl } from "./links";

export type BrowserPreviewScrollCache = Map<string, BrowserPreviewScrollPosition>;

const CANVAS_COLOR_BODY =
  /^(?:(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s*\/\s*((?:0|1)(?:\.0+)?|0?\.\d+))?|(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*((?:0|1)(?:\.0+)?|0?\.\d+))?)$/;

/** Accepts the opaque color a preview document reports as its canvas.
 * WebKit and Chromium serialize `getComputedStyle` colors differently, so both
 * `rgb(30, 34, 39)` and `rgb(30 34 39 / 1)` are allowed. Anything else is
 * ignored so a framed page cannot restyle the iframe with an arbitrary value. */
export function previewCanvasColor(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const color = value.trim();
  const body = /^rgba?\((.*)\)$/i.exec(color)?.[1];
  if (!body || color.length > 48) {
    return null;
  }
  const match = CANVAS_COLOR_BODY.exec(body);
  if (!match) {
    return null;
  }
  const channels = [1, 2, 3, 5, 6, 7]
    .map((index) => match[index])
    .filter((channel) => channel !== undefined)
    .map(Number);
  if (channels.slice(0, 3).some((channel) => channel > 255)) {
    return null;
  }
  const alpha = match[4] ?? match[8];
  if (alpha !== undefined && Number(alpha) < 1) {
    return null;
  }
  return color;
}

export function rememberBrowserPreviewScroll(
  cache: BrowserPreviewScrollCache,
  ownerId: string,
  position: BrowserPreviewScrollPosition,
) {
  cache.set(ownerId, position);
}

export function browserPreviewScrollFor(
  cache: BrowserPreviewScrollCache,
  ownerId: string,
  url: string | null,
): BrowserPreviewScrollPosition | null {
  const position = cache.get(ownerId);
  return position && position.url === url ? position : null;
}

export function pruneBrowserPreviewScroll(
  cache: BrowserPreviewScrollCache,
  retainedOwnerIds: ReadonlySet<string>,
) {
  for (const ownerId of cache.keys()) {
    if (!retainedOwnerIds.has(ownerId)) {
      cache.delete(ownerId);
    }
  }
}

export function browserOverlayIsOpen(
  state: BrowserOverlayState | undefined,
): boolean {
  return state?.open === true;
}

export function browserOverlayTerminalFocusTarget(
  overlays: Record<string, BrowserOverlayState>,
  ownerId: string | null | undefined,
  terminalPaneIds: ReadonlySet<string>,
): string | null {
  return ownerId && overlays[ownerId]?.open && terminalPaneIds.has(ownerId) ? ownerId : null;
}

function documentHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return undefined;
  }
}

/** True when the overlay is already showing this link's document. */
export function browserOverlayShowsLink(
  overlay: BrowserOverlayState | undefined,
  target: { url?: string; path?: string },
  fileServerPort: number | null,
): boolean {
  if (!overlay?.open || !overlay.url) {
    return false;
  }
  if (target.url) {
    const current = documentHref(overlay.url);
    const next = documentHref(target.url);
    if (current && next && current === next) {
      return true;
    }
  }
  if (target.path) {
    const overlayPath = pathFromFileServerUrl(overlay.url, fileServerPort);
    if (overlayPath && displayPathsReferToSameDirectory(overlayPath, target.path)) {
      return true;
    }
  }
  return false;
}

export function closeBrowserOverlayState(
  overlays: Record<string, BrowserOverlayState>,
  ownerId: string,
): Record<string, BrowserOverlayState> {
  const overlay = overlays[ownerId];
  if (!overlay?.open) {
    return overlays;
  }
  return { ...overlays, [ownerId]: { ...overlay, open: false } };
}

export function anyBrowserOverlayOpen(
  overlays: Record<string, BrowserOverlayState>,
): boolean {
  return Object.values(overlays).some((state) => state.open);
}

/** Marks every overlay closed. Returns the previous record when nothing changed. */
export function closeAllBrowserOverlaysState(
  overlays: Record<string, BrowserOverlayState>,
): Record<string, BrowserOverlayState> {
  let changed = false;
  const next: Record<string, BrowserOverlayState> = {};
  for (const [ownerId, state] of Object.entries(overlays)) {
    if (state.open) {
      next[ownerId] = { ...state, open: false };
      changed = true;
    } else {
      next[ownerId] = state;
    }
  }
  return changed ? next : overlays;
}

export type TranscriptOrBrowserToggle =
  | { type: "close-browser" }
  | { type: "toggle-transcript" }
  | { type: "toggle-browser" };

/** ⌘⇧E: a live browser always wins so the same chord can dismiss a leftover square. */
export function resolveTranscriptOrBrowserToggle(input: {
  anyBrowserOpen: boolean;
  canToggleTranscript: boolean;
}): TranscriptOrBrowserToggle {
  if (input.anyBrowserOpen) {
    return { type: "close-browser" };
  }
  if (input.canToggleTranscript) {
    return { type: "toggle-transcript" };
  }
  return { type: "toggle-browser" };
}
