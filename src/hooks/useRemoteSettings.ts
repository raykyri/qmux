import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { RemoteChoice, RemoteProbeResult, RuntimeConfig } from "../types";
import { deleteRemote, probeRemote, upsertRemote } from "../lib/api";
import { unknownErrorMessage } from "../lib/errors";
import {
  availableRemoteId,
  remoteDraftFromSshAlias,
  remoteSettingsDraft,
  savedRemoteFromSettingsDraft,
  type RemoteSettingsDraft,
} from "../lib/remoteSettings";

type Options = {
  config: RuntimeConfig | null;
  setConfig: Dispatch<SetStateAction<RuntimeConfig | null>>;
  settingsOpen: boolean;
  settingsTab: string;
  showAppToast: (message: string) => void;
};

// Own draft edits and probe generations together so stale responses cannot
// repopulate a changed draft or a closed settings panel.
export function useRemoteSettings({
  config,
  setConfig,
  settingsOpen,
  settingsTab,
  showAppToast,
}: Options) {
  const [expandedSettingsRemoteId, setExpandedSettingsRemoteId] = useState<
    string | null
  >(null);
  const [remoteAddMenuOpen, setRemoteAddMenuOpen] = useState(false);
  const remoteAddMenuRef = useRef<HTMLDivElement | null>(null);
  const remoteAddMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [remoteSettingsDraftState, setRemoteSettingsDraftState] =
    useState<RemoteSettingsDraft | null>(null);
  const [remoteSettingsDraftIsNew, setRemoteSettingsDraftIsNew] =
    useState(false);
  const [remoteSettingsIdManuallyEdited, setRemoteSettingsIdManuallyEdited] =
    useState(false);
  const [remoteSettingsSaving, setRemoteSettingsSaving] = useState(false);
  const [remoteSettingsError, setRemoteSettingsError] = useState<string | null>(
    null,
  );
  const [remoteDeleteConfirm, setRemoteDeleteConfirm] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const remoteDeleteConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const [remoteProbeResults, setRemoteProbeResults] = useState<
    Record<string, RemoteProbeResult>
  >({});
  const [remoteProbeLoadingId, setRemoteProbeLoadingId] = useState<
    string | null
  >(null);
  const remoteProbeRequestRef = useRef(0);
  const remoteProbeGenerationByKeyRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!settingsOpen || settingsTab !== "remotes") {
      setRemoteAddMenuOpen(false);
      setRemoteDeleteConfirm(null);
      const generation = ++remoteProbeRequestRef.current;
      for (const key of Object.keys(remoteProbeGenerationByKeyRef.current)) {
        remoteProbeGenerationByKeyRef.current[key] = generation;
      }
      setRemoteProbeLoadingId((current) => (current === null ? current : null));
      setRemoteProbeResults((current) =>
        Object.keys(current).length === 0 ? current : {},
      );
    }
  }, [settingsOpen, settingsTab]);

  function remoteProbeKey(id: string | null | undefined) {
    const trimmed = id?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : "__new__";
  }

  function resetRemoteProbe(id: string) {
    const key = remoteProbeKey(id);
    remoteProbeGenerationByKeyRef.current[key] =
      ++remoteProbeRequestRef.current;
    setRemoteProbeResults((current) => {
      if (!(key in current)) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
    setRemoteProbeLoadingId((current) => (current === key ? null : current));
  }

  function changeRemoteSettingsDraft(
    update: (current: RemoteSettingsDraft) => RemoteSettingsDraft,
  ) {
    if (remoteSettingsDraftState) {
      resetRemoteProbe(remoteSettingsDraftState.id);
    }
    setRemoteSettingsError(null);
    setRemoteSettingsDraftState((current) =>
      current ? update(current) : current,
    );
  }

  function beginAddingRemote() {
    const id = availableRemoteId("remote", config?.remotes ?? []);
    setExpandedSettingsRemoteId("__new__");
    setRemoteSettingsDraftState({
      id,
      label: "",
      host: "",
      workspaceRoot: "",
      qmuxCli: "",
      multiplexer: "tmux",
    });
    setRemoteSettingsDraftIsNew(true);
    setRemoteSettingsIdManuallyEdited(false);
    setRemoteSettingsError(null);
    setRemoteDeleteConfirm(null);
  }

  function beginAddingRemoteFromSshAlias(alias: string) {
    setExpandedSettingsRemoteId("__new__");
    setRemoteSettingsDraftState(
      remoteDraftFromSshAlias(alias, config?.remotes ?? []),
    );
    setRemoteSettingsDraftIsNew(true);
    setRemoteSettingsIdManuallyEdited(false);
    setRemoteSettingsError(null);
    setRemoteDeleteConfirm(null);
  }

  function beginCopyingRemote(remote: RemoteChoice) {
    const id = availableRemoteId(`${remote.id}-copy`, config?.remotes ?? []);
    setExpandedSettingsRemoteId("__new__");
    setRemoteSettingsDraftState({
      ...remoteSettingsDraft(remote),
      id,
      label: `${remote.label} copy`,
      // The UI only creates driveable remotes. A config entry may retain the
      // documented future-facing `herdr` value, but its editable copy should
      // be immediately usable by qmux.
      multiplexer: "tmux",
    });
    setRemoteSettingsDraftIsNew(true);
    setRemoteSettingsIdManuallyEdited(false);
    setRemoteSettingsError(null);
    setRemoteDeleteConfirm(null);
  }

  function toggleRemoteSettings(remote: RemoteChoice) {
    if (expandedSettingsRemoteId === remote.id) {
      setExpandedSettingsRemoteId(null);
      setRemoteSettingsDraftState(null);
      setRemoteSettingsError(null);
      setRemoteDeleteConfirm(null);
      return;
    }
    setExpandedSettingsRemoteId(remote.id);
    setRemoteSettingsDraftState(remoteSettingsDraft(remote));
    setRemoteSettingsDraftIsNew(false);
    setRemoteSettingsIdManuallyEdited(true);
    setRemoteSettingsError(null);
    setRemoteDeleteConfirm(null);
  }

  async function saveRemoteSettings() {
    const draft = remoteSettingsDraftState;
    if (!draft || remoteSettingsSaving) {
      return;
    }
    const id = draft.id.trim();
    const label = draft.label.trim();
    const host = draft.host.trim();
    if (!id || !label || !host) {
      setRemoteSettingsError("Name, ID, and SSH host are required.");
      return;
    }
    if (
      remoteSettingsDraftIsNew &&
      (config?.remotes ?? []).some((remote) => remote.id === id)
    ) {
      setRemoteSettingsError(`A remote with the ID “${id}” already exists.`);
      return;
    }
    const remote = savedRemoteFromSettingsDraft({ ...draft, label, host });
    setRemoteSettingsSaving(true);
    setRemoteSettingsError(null);
    try {
      const remotes = await upsertRemote(id, remote);
      setConfig((current) => (current ? { ...current, remotes } : current));
      setExpandedSettingsRemoteId(id);
      setRemoteSettingsDraftState({ ...draft, id, label, host });
      setRemoteSettingsDraftIsNew(false);
      showAppToast(
        remoteSettingsDraftIsNew ? "Remote added" : "Remote updated",
      );
    } catch (err) {
      setRemoteSettingsError(unknownErrorMessage(err));
    } finally {
      setRemoteSettingsSaving(false);
    }
  }

  async function testRemoteSettings(draft: RemoteSettingsDraft) {
    if (!draft.host.trim()) {
      setRemoteSettingsError("Enter an SSH host before testing.");
      return;
    }
    const key = remoteProbeKey(draft.id);
    const generation = ++remoteProbeRequestRef.current;
    remoteProbeGenerationByKeyRef.current[key] = generation;
    setRemoteProbeLoadingId(key);
    setRemoteProbeResults((current) => {
      if (!(key in current)) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
    setRemoteSettingsError(null);
    try {
      const result = await probeRemote(savedRemoteFromSettingsDraft(draft));
      if (remoteProbeGenerationByKeyRef.current[key] !== generation) {
        return;
      }
      setRemoteProbeResults((current) => ({ ...current, [key]: result }));
    } catch (err) {
      if (remoteProbeGenerationByKeyRef.current[key] !== generation) {
        return;
      }
      setRemoteSettingsError(unknownErrorMessage(err));
    } finally {
      if (remoteProbeGenerationByKeyRef.current[key] === generation) {
        setRemoteProbeLoadingId((current) =>
          current === key ? null : current,
        );
      }
    }
  }

  async function removeRemoteSettings(id: string) {
    if (remoteSettingsSaving) {
      return;
    }
    setRemoteSettingsSaving(true);
    setRemoteSettingsError(null);
    try {
      const remotes = await deleteRemote(id);
      setConfig((current) => (current ? { ...current, remotes } : current));
      setExpandedSettingsRemoteId(null);
      setRemoteSettingsDraftState(null);
      setRemoteDeleteConfirm(null);
      resetRemoteProbe(id);
      showAppToast("Remote removed");
    } catch (err) {
      setRemoteSettingsError(unknownErrorMessage(err));
    } finally {
      setRemoteSettingsSaving(false);
    }
  }

  return {
    expandedSettingsRemoteId,
    setExpandedSettingsRemoteId,
    remoteAddMenuOpen,
    setRemoteAddMenuOpen,
    remoteAddMenuRef,
    remoteAddMenuButtonRef,
    remoteSettingsDraftState,
    setRemoteSettingsDraftState,
    remoteSettingsDraftIsNew,
    setRemoteSettingsDraftIsNew,
    remoteSettingsIdManuallyEdited,
    setRemoteSettingsIdManuallyEdited,
    remoteSettingsSaving,
    remoteSettingsError,
    setRemoteSettingsError,
    remoteDeleteConfirm,
    setRemoteDeleteConfirm,
    remoteDeleteConfirmButtonRef,
    remoteProbeResults,
    remoteProbeLoadingId,
    remoteProbeKey,
    resetRemoteProbe,
    changeRemoteSettingsDraft,
    beginAddingRemote,
    beginAddingRemoteFromSshAlias,
    beginCopyingRemote,
    toggleRemoteSettings,
    saveRemoteSettings,
    testRemoteSettings,
    removeRemoteSettings,
  };
}

export type RemoteSettingsController = ReturnType<typeof useRemoteSettings>;
