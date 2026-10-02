import { LoaderCircle } from "lucide-react";
import { Button, Input } from "./ui";
import RemoteProbeChecks from "./RemoteProbeChecks";
import { adapterReadinessLabel } from "../lib/adapterReadiness";
import { availableRemoteId, remoteIdFromLabel } from "../lib/remoteSettings";
import type { RemoteChoice } from "../types";
import type { RemoteSettingsController } from "../hooks/useRemoteSettings";

export function RemoteProbeStatus({
  controller,
  probeKey,
}: {
  controller: RemoteSettingsController;
  probeKey: string;
}) {
  const { remoteProbeLoadingId, remoteProbeResults } = controller;
  const probeLoading = remoteProbeLoadingId === probeKey;
  const probeResult = remoteProbeResults[probeKey];
  if (probeLoading) {
    return (
      <div className="settings-remote-probe-loading" role="status">
        <LoaderCircle size={14} className="is-spinning" aria-hidden="true" />
        Checking SSH, tmux, qmux-cli, and agent providers…
      </div>
    );
  }
  if (!probeResult) {
    return null;
  }
  const remoteAdapters = probeResult.adapters.filter(
    (adapter) => adapter.supportsRemote,
  );
  return (
    <div className="settings-remote-probe-result" aria-live="polite">
      <RemoteProbeChecks checks={probeResult.checks} />
      {remoteAdapters.length > 0 ? (
        <div className="settings-remote-provider-results">
          <span>Remote agent providers</span>
          {remoteAdapters.map((adapter) => (
            <div key={adapter.instanceId}>
              <strong>{adapter.label}</strong>
              <span className={`settings-agent-status is-${adapter.readiness}`}>
                {adapterReadinessLabel(adapter)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function RemoteSettingsForm({
  controller,
  remotes,
  sshConfigAliases,
}: {
  controller: RemoteSettingsController;
  remotes: RemoteChoice[];
  sshConfigAliases: string[];
}) {
  const {
    setExpandedSettingsRemoteId,
    remoteSettingsDraftState,
    setRemoteSettingsDraftState,
    remoteSettingsDraftIsNew,
    setRemoteSettingsDraftIsNew,
    remoteSettingsIdManuallyEdited,
    setRemoteSettingsIdManuallyEdited,
    remoteSettingsSaving,
    remoteSettingsError,
    setRemoteSettingsError,
    setRemoteDeleteConfirm,
    remoteProbeLoadingId,
    remoteProbeKey,
    resetRemoteProbe,
    changeRemoteSettingsDraft,
    saveRemoteSettings,
    testRemoteSettings,
  } = controller;
  const draft = remoteSettingsDraftState;
  if (!draft) {
    return null;
  }
  const fieldPrefix = `settings-remote-${encodeURIComponent(draft.id || "new")}`;
  const probeKey = remoteProbeKey(draft.id);
  const probeLoading = remoteProbeLoadingId === probeKey;
  return (
    <div className="settings-remote-detail">
      <div className="settings-remote-fields settings-remote-fields-id">
        <label htmlFor={`${fieldPrefix}-id`}>
          <span>ID</span>
          <Input
            id={`${fieldPrefix}-id`}
            type="text"
            value={draft.id}
            disabled={!remoteSettingsDraftIsNew}
            spellCheck={false}
            onChange={(event) => {
              const id = remoteIdFromLabel(event.currentTarget.value);
              setRemoteSettingsIdManuallyEdited(true);
              changeRemoteSettingsDraft((current) => ({ ...current, id }));
            }}
          />
        </label>
      </div>
      <div className="settings-remote-fields">
        <label htmlFor={`${fieldPrefix}-label`}>
          <span>Name</span>
          <Input
            id={`${fieldPrefix}-label`}
            type="text"
            autoFocus={remoteSettingsDraftIsNew}
            value={draft.label}
            placeholder="Build server"
            onChange={(event) => {
              const label = event.currentTarget.value;
              changeRemoteSettingsDraft((current) => {
                const nextSlug = remoteIdFromLabel(label);
                const id =
                  remoteSettingsDraftIsNew &&
                  !remoteSettingsIdManuallyEdited &&
                  nextSlug
                    ? availableRemoteId(nextSlug, remotes)
                    : current.id;
                return { ...current, label, id };
              });
            }}
          />
        </label>
        <label htmlFor={`${fieldPrefix}-host`}>
          <span>SSH host</span>
          <Input
            id={`${fieldPrefix}-host`}
            type="text"
            value={draft.host}
            placeholder="devbox or user@host"
            list={
              sshConfigAliases.length > 0
                ? "settings-ssh-host-aliases"
                : undefined
            }
            spellCheck={false}
            onChange={(event) => {
              const host = event.currentTarget.value;
              changeRemoteSettingsDraft((current) => ({ ...current, host }));
            }}
          />
          {sshConfigAliases.length > 0 ? (
            <small>
              {sshConfigAliases.length} aliases available from ~/.ssh/config
            </small>
          ) : null}
        </label>
        <label htmlFor={`${fieldPrefix}-root`}>
          <span>
            Workspace root <small>optional</small>
          </span>
          <Input
            id={`${fieldPrefix}-root`}
            type="text"
            value={draft.workspaceRoot}
            placeholder="~/.qmux/workspaces"
            spellCheck={false}
            onChange={(event) => {
              const workspaceRoot = event.currentTarget.value;
              changeRemoteSettingsDraft((current) => ({
                ...current,
                workspaceRoot,
              }));
            }}
          />
        </label>
        <label htmlFor={`${fieldPrefix}-cli`}>
          <span>
            qmux CLI <small>optional</small>
          </span>
          <Input
            id={`${fieldPrefix}-cli`}
            type="text"
            value={draft.qmuxCli}
            placeholder="qmux-cli"
            spellCheck={false}
            onChange={(event) => {
              const qmuxCli = event.currentTarget.value;
              changeRemoteSettingsDraft((current) => ({ ...current, qmuxCli }));
            }}
          />
        </label>
        <datalist id="settings-ssh-host-aliases">
          {sshConfigAliases.map((alias) => (
            <option value={alias} key={alias} />
          ))}
        </datalist>
      </div>
      {remoteSettingsError ? (
        <p className="settings-agent-error" role="alert">
          {remoteSettingsError}
        </p>
      ) : null}
      <RemoteProbeStatus controller={controller} probeKey={probeKey} />
      <div className="settings-remote-actions">
        <Button
          type="button"
          className="settings-remote-test"
          disabled={remoteSettingsSaving || probeLoading}
          onClick={() => void testRemoteSettings(draft)}
        >
          {probeLoading ? "Testing…" : "Test connection"}
        </Button>
        {!remoteSettingsDraftIsNew ? (
          <Button
            type="button"
            className="settings-remote-remove"
            disabled={remoteSettingsSaving}
            onClick={() => {
              setRemoteSettingsError(null);
              setRemoteDeleteConfirm({
                id: draft.id,
                label: draft.label.trim() || draft.id,
              });
            }}
          >
            Remove
          </Button>
        ) : (
          <Button
            type="button"
            className="settings-remote-remove"
            disabled={remoteSettingsSaving}
            onClick={() => {
              setExpandedSettingsRemoteId(null);
              setRemoteSettingsDraftState(null);
              setRemoteSettingsDraftIsNew(false);
              setRemoteSettingsError(null);
              resetRemoteProbe(draft.id);
            }}
          >
            Cancel
          </Button>
        )}
        <Button
          type="button"
          className="settings-remote-save"
          disabled={remoteSettingsSaving}
          onClick={() => void saveRemoteSettings()}
        >
          {remoteSettingsSaving
            ? "Saving…"
            : remoteSettingsDraftIsNew
              ? "Add remote"
              : "Save"}
        </Button>
      </div>
    </div>
  );
}
