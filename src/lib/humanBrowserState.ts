import type { BrowserOverlayState } from "../appTypes";

export type HumanBrowserNavigationState = {
  // Completion releases location observations; acknowledgement controls which
  // revision surface/observed-URL syncs may safely send back to native. Failure
  // can precede OR follow native commit, so acknowledgement is a lower bound.
  settledRevision: number | null;
  acknowledgedRevision: number;
};

/** Keep navigation progress for the owner's lifetime: an inactive tab unmounts
 * its overlay while retaining the native page. Forgetting a rejected attempt
 * would replay its revision with the recovered URL when that tab returns. */
export function humanBrowserNavigationStateFor(
  cache: Map<string, HumanBrowserNavigationState>,
  ownerId: string,
): HumanBrowserNavigationState {
  let state = cache.get(ownerId);
  if (!state) {
    state = { settledRevision: null, acknowledgedRevision: 0 };
    cache.set(ownerId, state);
  }
  return state;
}

export function pruneHumanBrowserNavigationState(
  cache: Map<string, HumanBrowserNavigationState>,
  retainedOwnerIds: ReadonlySet<string>,
) {
  for (const ownerId of cache.keys()) {
    if (!retainedOwnerIds.has(ownerId)) cache.delete(ownerId);
  }
}

export function browserOverlayUsesNativeHumanChild(
  state: BrowserOverlayState | undefined,
): boolean {
  return Boolean(
    state?.open && !state.sandbox && state.url !== null,
  );
}

export function nativeHumanBrowserOwnerIds(
  overlays: Record<string, BrowserOverlayState>,
): Set<string> {
  return new Set(
    Object.entries(overlays)
      .filter(([, state]) => browserOverlayUsesNativeHumanChild(state))
      .map(([ownerId]) => ownerId),
  );
}
