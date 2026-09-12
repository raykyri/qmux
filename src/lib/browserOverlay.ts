import type { BrowserOverlayState } from "../appTypes";
import { displayPathsReferToSameDirectory } from "./appHelpers";
import { pathFromFileServerUrl } from "./links";

export function browserOverlayIsOpen(
  state: BrowserOverlayState | undefined,
): boolean {
  return state?.open === true;
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
