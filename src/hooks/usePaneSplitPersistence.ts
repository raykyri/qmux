import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { getPaneSplits, setPaneSplits } from "../lib/api";
import {
  normalizePaneSplitsForPanes,
  paneSnapshotForPersistedPaneSplits,
} from "../lib/paneSplits";
import type { PaneInfo, PaneSplitInfo } from "../types";

/** Orders local split saves and defers their backend echoes until saves settle. */
export function usePaneSplitPersistence(
  paneSplitsRef: RefObject<PaneSplitInfo[]>,
  panesRef: RefObject<PaneInfo[]>,
  reportError: (message: string) => void,
) {
  const [paneSplits, updatePaneSplitsState] = useState<PaneSplitInfo[]>([]);
  const saveRevisionRef = useRef(0);
  const eventRevisionRef = useRef(0);
  const layoutRevisionRef = useRef(0);
  const pendingRef = useRef(new Set<number>());
  const deferredEchoRef = useRef(false);
  const lifetimeRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lifetimeRef.current += 1;
      pendingRef.current.clear();
      deferredEchoRef.current = false;
    };
  }, []);

  // Update the authoritative ref at the write, not during the next render:
  // consecutive keyboard steps can be dispatched in the same React batch.
  const setPaneSplitsState = useCallback((splits: PaneSplitInfo[]) => {
    layoutRevisionRef.current += 1;
    paneSplitsRef.current = splits;
    updatePaneSplitsState(splits);
  }, [paneSplitsRef]);

  function reconcileDeferredEcho() {
    const lifetime = lifetimeRef.current;
    const saveRevision = saveRevisionRef.current;
    const eventRevision = eventRevisionRef.current;
    const layoutRevision = layoutRevisionRef.current;
    void getPaneSplits().then((latest) => {
      if (
        !mountedRef.current || lifetime !== lifetimeRef.current ||
        pendingRef.current.size > 0 || saveRevision !== saveRevisionRef.current ||
        eventRevision !== eventRevisionRef.current || layoutRevision !== layoutRevisionRef.current
      ) return;
      // Like an event payload, this snapshot is already normalized by the
      // backend. The matching pane-created event may not have arrived yet.
      setPaneSplitsState(latest);
    }).catch(() => undefined);
  }

  function savePaneSplits(
    nextSplits: PaneSplitInfo[],
    paneSnapshot = panesRef.current,
    { reportErrors = true }: { reportErrors?: boolean } = {},
  ) {
    if (!mountedRef.current) return;
    const normalized = normalizePaneSplitsForPanes(nextSplits, paneSnapshot);
    const token = ++saveRevisionRef.current;
    const lifetime = lifetimeRef.current;
    pendingRef.current.add(token);
    setPaneSplitsState(normalized);
    const layoutRevision = layoutRevisionRef.current;
    const isCurrent = () => mountedRef.current && lifetime === lifetimeRef.current;
    const mayApply = () => isCurrent() && token === saveRevisionRef.current &&
      layoutRevision === layoutRevisionRef.current;
    void setPaneSplits(normalized).then((persisted) => {
      if (!mayApply()) return;
      const paneBasis = paneSnapshotForPersistedPaneSplits(
        persisted, panesRef.current, paneSnapshot,
      );
      setPaneSplitsState(normalizePaneSplitsForPanes(persisted, paneBasis));
    }).catch((error) => {
      if (mayApply() && reportErrors) {
        reportError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (!isCurrent()) return;
      pendingRef.current.delete(token);
      if (pendingRef.current.size === 0 && deferredEchoRef.current) {
        deferredEchoRef.current = false;
        reconcileDeferredEcho();
      }
    });
  }

  function onPaneSplitsChanged(splits: PaneSplitInfo[]) {
    if (!mountedRef.current) return;
    // Even an accepted external event must invalidate an earlier GET. A local
    // save counter alone cannot distinguish those snapshots from newer events.
    eventRevisionRef.current += 1;
    if (pendingRef.current.size > 0) {
      deferredEchoRef.current = true;
      return;
    }
    setPaneSplitsState(splits);
  }

  return { paneSplits, setPaneSplitsState, savePaneSplits, onPaneSplitsChanged };
}
