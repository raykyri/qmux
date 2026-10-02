import { useRef, useState } from "react";
import { createGroupWithShell } from "../lib/api";
import { waitForPaintedFrame } from "../lib/paint";
import type { InitialPaneSize } from "../types";

export interface PendingRemoteGroup {
  id: number;
  label: string;
  protocol: "ssh" | "sftp";
  afterGroupId: string | null;
}

export function useRemoteGroupCreation() {
  // These are presentation-only records: never expose temporary IDs to group
  // actions, persistence, drag ordering, or backend event reconciliation.
  const [pendingRemoteGroups, setPendingRemoteGroups] = useState<PendingRemoteGroup[]>([]);
  const nextId = useRef(0);

  async function createPendingRemoteGroup(
    remoteId: string,
    label: string,
    protocol: PendingRemoteGroup["protocol"],
    afterGroupId: string | null,
    initialSize: InitialPaneSize,
  ) {
    const pending = { id: ++nextId.current, label, protocol, afterGroupId };
    setPendingRemoteGroups((current) => [...current, pending]);
    try {
      // CLI provisioning and home-directory discovery can require several SSH
      // round trips. Show the group before invoking any of that work.
      await waitForPaintedFrame();
      return await createGroupWithShell("~", afterGroupId, initialSize, remoteId, protocol);
    } finally {
      setPendingRemoteGroups((current) => current.filter((group) => group.id !== pending.id));
    }
  }

  return { pendingRemoteGroups, createPendingRemoteGroup };
}
