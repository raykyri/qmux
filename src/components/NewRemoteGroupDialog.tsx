import { FolderOpen, LoaderCircle, Plus, SquareTerminal } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { listSshConfigAliases, probeRemote, upsertRemote } from "../lib/api";
import {
  availableRemoteId,
  savedRemoteFromSettingsDraft,
  unconfiguredSshAliases,
  type RemoteSettingsDraft,
} from "../lib/remoteSettings";
import type { RemoteChoice, RemoteProbeResult } from "../types";
import RemoteProbeChecks from "./RemoteProbeChecks";
import {
  Button,
  DialogActions,
  DialogForm,
  DialogRoot,
  DialogTitle,
  Input,
  SegmentedControl,
  classNames,
  useListbox,
} from "./ui";
import type { ListboxOption } from "./ui";

export type RemoteGroupProtocol = "ssh" | "sftp";

const LAST_CHOICE_KEY = "qmux.new-remote-group.v1";
const ADD_REMOTE_VALUE = "__add__";
const MAX_ALIAS_SUGGESTIONS = 6;

interface LastChoice {
  remoteId: string | null;
  protocol: RemoteGroupProtocol;
}

function readLastChoice(): LastChoice {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_CHOICE_KEY) ?? "null") as
      | Partial<LastChoice>
      | null;
    return {
      remoteId: typeof parsed?.remoteId === "string" ? parsed.remoteId : null,
      protocol: parsed?.protocol === "sftp" ? "sftp" : "ssh",
    };
  } catch {
    return { remoteId: null, protocol: "ssh" };
  }
}

function emptyDraft(): RemoteSettingsDraft {
  return { id: "", label: "", host: "", workspaceRoot: "", qmuxCli: "", multiplexer: "tmux" };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface NewRemoteGroupDialogProps {
  remotes: RemoteChoice[];
  onCreate: (remoteId: string, protocol: RemoteGroupProtocol) => Promise<void>;
  onRemotesChange: (remotes: RemoteChoice[]) => void;
  onManageRemotes: () => void;
  onDismiss: () => void;
}

/** Picks (or adds) a saved remote and how the new group's first tab connects. */
export default function NewRemoteGroupDialog({
  remotes,
  onCreate,
  onRemotesChange,
  onManageRemotes,
  onDismiss,
}: NewRemoteGroupDialogProps) {
  const idPrefix = useId();
  const [lastChoice] = useState(readLastChoice);
  const [selectedId, setSelectedId] = useState<string>(() => {
    const usable = remotes.filter((remote) => remote.usable);
    return (
      usable.find((remote) => remote.id === lastChoice.remoteId)?.id ?? usable[0]?.id ?? ""
    );
  });
  const [protocol, setProtocol] = useState<RemoteGroupProtocol>(lastChoice.protocol);
  const [adding, setAdding] = useState(remotes.length === 0);
  const [draft, setDraft] = useState<RemoteSettingsDraft>(emptyDraft);
  const [labelEdited, setLabelEdited] = useState(false);
  const [aliases, setAliases] = useState<string[]>([]);
  const [probe, setProbe] = useState<RemoteProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const probeGenerationRef = useRef(0);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const hostInputRef = useRef<HTMLInputElement | null>(null);
  const busy = saving || creating;

  useEffect(() => {
    let cancelled = false;
    listSshConfigAliases()
      .then((found) => {
        if (!cancelled) setAliases(found);
      })
      // Suggestions are a convenience; a missing or unreadable ssh config
      // just means the host is typed by hand.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const aliasSuggestions = useMemo(
    () => unconfiguredSshAliases(aliases, remotes).slice(0, MAX_ALIAS_SUGGESTIONS),
    [aliases, remotes],
  );

  const options = useMemo<ListboxOption[]>(
    () => [
      ...remotes.map((remote) => ({
        value: remote.id,
        label: remote.label,
        disabled: !remote.usable,
      })),
      { value: ADD_REMOTE_VALUE, label: "Add remote…" },
    ],
    [remotes],
  );
  const listbox = useListbox({
    options,
    value: selectedId,
    open: !adding,
    onOpenChange: () => undefined,
    onChange: (value) => {
      if (value === ADD_REMOTE_VALUE) beginAdding();
      else setSelectedId(value);
    },
  });

  // Selection follows the keyboard, like a radio group: arrowing onto a
  // remote selects it, so Enter then creates the group there.
  const activeValue = listbox.activeOption?.value;
  useEffect(() => {
    const activeDisabled = listbox.activeOption?.disabled;
    if (!adding && activeValue && activeValue !== ADD_REMOTE_VALUE && !activeDisabled) {
      setSelectedId(activeValue);
    }
  }, [activeValue, adding, listbox.activeOption?.disabled]);

  const selectedRemote = remotes.find((remote) => remote.id === selectedId && remote.usable);

  function beginAdding() {
    setAdding(true);
    setDraft(emptyDraft());
    setLabelEdited(false);
    resetProbe();
    setError(null);
  }

  function stopAdding() {
    setAdding(false);
    resetProbe();
    setError(null);
    requestAnimationFrame(() => listboxRef.current?.focus());
  }

  function resetProbe() {
    probeGenerationRef.current += 1;
    setProbe(null);
    setProbing(false);
  }

  function changeDraft(update: Partial<RemoteSettingsDraft>) {
    resetProbe();
    setError(null);
    setDraft((current) => ({ ...current, ...update }));
  }

  function changeHost(host: string) {
    changeDraft(labelEdited ? { host } : { host, label: host });
  }

  async function testConnection() {
    if (!draft.host.trim()) {
      setError("Enter an SSH host before testing.");
      hostInputRef.current?.focus();
      return;
    }
    const generation = ++probeGenerationRef.current;
    setProbe(null);
    setProbing(true);
    setError(null);
    try {
      const result = await probeRemote(savedRemoteFromSettingsDraft(draft));
      if (probeGenerationRef.current === generation) setProbe(result);
    } catch (err) {
      if (probeGenerationRef.current === generation) setError(errorMessage(err));
    } finally {
      if (probeGenerationRef.current === generation) setProbing(false);
    }
  }

  async function saveRemote() {
    const host = draft.host.trim();
    if (!host) {
      setError("Enter an SSH host.");
      hostInputRef.current?.focus();
      return;
    }
    const label = draft.label.trim() || host;
    const id = availableRemoteId(label, remotes);
    setSaving(true);
    setError(null);
    try {
      const next = await upsertRemote(id, savedRemoteFromSettingsDraft({ ...draft, label, host }));
      onRemotesChange(next);
      setSelectedId(id);
      stopAdding();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function createGroup() {
    if (!selectedRemote || busy) return;
    setCreating(true);
    setError(null);
    try {
      await onCreate(selectedRemote.id, protocol);
    } catch (err) {
      setError(errorMessage(err));
      setCreating(false);
      return;
    }
    try {
      localStorage.setItem(
        LAST_CHOICE_KEY,
        JSON.stringify({ remoteId: selectedRemote.id, protocol } satisfies LastChoice),
      );
    } catch {
      // Remembering the choice is best-effort.
    }
  }

  const titleId = `${idPrefix}-title`;
  const remoteLabelId = `${idPrefix}-remote-label`;
  const protocolLabelId = `${idPrefix}-protocol-label`;
  const protocolHintId = `${idPrefix}-protocol-hint`;
  const optionId = (index: number) => `${idPrefix}-remote-${index}`;
  const targetName = adding
    ? draft.label.trim() || draft.host.trim() || "the new remote"
    : (selectedRemote?.label ?? "the remote");

  return (
    <DialogRoot
      // Escape (or a backdrop click) from the add form returns to the remote
      // list rather than discarding the whole dialog.
      onDismiss={adding && remotes.length > 0 ? stopAdding : onDismiss}
      dismissDisabled={busy}
    >
      <DialogForm
        className="remote-group-dialog"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          if (adding) void saveRemote();
          else void createGroup();
        }}
      >
        <DialogTitle id={titleId}>New remote group</DialogTitle>

        {adding ? (
          <div className="remote-group-dialog-section">
            <div className="remote-group-dialog-section-head">
              <span className="confirm-dialog-field-label">
                {remotes.length > 0 ? "Add remote" : "Add your first remote"}
              </span>
              {remotes.length > 0 ? (
                <Button variant="link" disabled={saving} onClick={stopAdding}>
                  Back to remotes
                </Button>
              ) : null}
            </div>
            <div className="remote-group-form">
              <label className="remote-group-form-field" htmlFor={`${idPrefix}-host`}>
                <span className="confirm-dialog-field-label">SSH host</span>
                <Input
                  ref={hostInputRef}
                  id={`${idPrefix}-host`}
                  type="text"
                  value={draft.host}
                  placeholder="devbox or user@host"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={saving}
                  data-dialog-initial-focus
                  autoFocus
                  onChange={(event) => changeHost(event.currentTarget.value)}
                />
              </label>
              {aliasSuggestions.length > 0 ? (
                <div className="remote-group-alias-suggestions">
                  <span className="rename-dialog-hint">From ~/.ssh/config:</span>
                  {aliasSuggestions.map((alias) => (
                    <Button
                      key={alias}
                      variant="unstyled"
                      className="remote-group-alias-chip"
                      disabled={saving}
                      onClick={() => changeHost(alias)}
                    >
                      {alias}
                    </Button>
                  ))}
                </div>
              ) : null}
              <label className="remote-group-form-field" htmlFor={`${idPrefix}-label`}>
                <span className="confirm-dialog-field-label">Name</span>
                <Input
                  id={`${idPrefix}-label`}
                  type="text"
                  value={draft.label}
                  placeholder="Build server"
                  autoComplete="off"
                  disabled={saving}
                  onChange={(event) => {
                    setLabelEdited(true);
                    changeDraft({ label: event.currentTarget.value });
                  }}
                />
              </label>
              <details className="remote-group-advanced">
                <summary>Advanced</summary>
                <div className="remote-group-form-row">
                  <label className="remote-group-form-field" htmlFor={`${idPrefix}-root`}>
                    <span className="confirm-dialog-field-label">Workspace root</span>
                    <Input
                      id={`${idPrefix}-root`}
                      type="text"
                      value={draft.workspaceRoot}
                      placeholder="~/.qmux/workspaces"
                      spellCheck={false}
                      disabled={saving}
                      onChange={(event) =>
                        changeDraft({ workspaceRoot: event.currentTarget.value })
                      }
                    />
                  </label>
                  <label className="remote-group-form-field" htmlFor={`${idPrefix}-cli`}>
                    <span className="confirm-dialog-field-label">qmux CLI</span>
                    <Input
                      id={`${idPrefix}-cli`}
                      type="text"
                      value={draft.qmuxCli}
                      placeholder="qmux-cli"
                      spellCheck={false}
                      disabled={saving}
                      onChange={(event) => changeDraft({ qmuxCli: event.currentTarget.value })}
                    />
                  </label>
                </div>
              </details>
              {probing ? (
                <div className="settings-remote-probe-loading" role="status">
                  <LoaderCircle size={14} className="is-spinning" aria-hidden="true" />
                  Checking SSH, tmux, and qmux-cli…
                </div>
              ) : probe ? (
                <div aria-live="polite">
                  <RemoteProbeChecks checks={probe.checks} />
                </div>
              ) : null}
              <div className="remote-group-form-actions">
                <Button size="sm" disabled={saving || probing} onClick={() => void testConnection()}>
                  {probing ? "Testing…" : "Test connection"}
                </Button>
                <Button type="submit" size="sm" tone="primary" disabled={saving}>
                  {saving ? "Saving…" : "Save remote"}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="remote-group-dialog-section">
            <div className="remote-group-dialog-section-head">
              <span className="confirm-dialog-field-label" id={remoteLabelId}>
                Remote
              </span>
              <Button variant="link" disabled={busy} onClick={onManageRemotes}>
                Manage in Settings
              </Button>
            </div>
            <div
              ref={listboxRef}
              className="remote-group-list"
              role="listbox"
              aria-labelledby={remoteLabelId}
              aria-activedescendant={
                listbox.activeIndex >= 0 ? optionId(listbox.activeIndex) : undefined
              }
              tabIndex={0}
              data-dialog-initial-focus
              onKeyDown={(event) => {
                // Enter on a remote creates the group; on "Add remote…" it
                // opens the form. The listbox hook would only reselect.
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (activeValue === ADD_REMOTE_VALUE) beginAdding();
                  else void createGroup();
                  return;
                }
                listbox.handleKeyDown(event);
              }}
            >
              {remotes.map((remote, index) => {
                const selected = remote.id === selectedId;
                return (
                  <div
                    key={remote.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={!remote.usable || undefined}
                    title={
                      remote.usable ? undefined : `qmux can't drive ${remote.multiplexer} yet`
                    }
                    className={classNames(
                      "remote-group-option",
                      selected && "is-selected",
                      listbox.activeIndex === index && "is-highlighted",
                      !remote.usable && "is-disabled",
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (!remote.usable || busy) return;
                      listbox.setActiveIndex(index);
                      setSelectedId(remote.id);
                      listboxRef.current?.focus();
                    }}
                    onDoubleClick={() => {
                      if (remote.usable) void createGroup();
                    }}
                  >
                    <span className="remote-group-option-radio" aria-hidden="true" />
                    <span className="remote-group-option-text">
                      <span className="remote-group-option-name">{remote.label}</span>
                      <span className="remote-group-option-host">{remote.host}</span>
                    </span>
                    <span
                      className={classNames(
                        "remote-group-option-badge",
                        !remote.usable && "is-warning",
                      )}
                    >
                      {remote.usable ? remote.multiplexer : `${remote.multiplexer} · unsupported`}
                    </span>
                  </div>
                );
              })}
              {remotes.length > 0 ? (
                <div className="remote-group-list-divider" role="presentation" />
              ) : null}
              <div
                id={optionId(remotes.length)}
                role="option"
                aria-selected={false}
                className={classNames(
                  "remote-group-option",
                  "remote-group-option-add",
                  listbox.activeIndex === remotes.length && "is-highlighted",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!busy) beginAdding();
                }}
              >
                <Plus size={14} aria-hidden="true" />
                <span>Add remote…</span>
              </div>
            </div>
          </div>
        )}

        <div className="remote-group-dialog-section">
          <span className="confirm-dialog-field-label" id={protocolLabelId}>
            Start with
          </span>
          <SegmentedControl
            name={`${idPrefix}-protocol`}
            value={protocol}
            disabled={busy}
            aria-labelledby={protocolLabelId}
            aria-describedby={protocolHintId}
            onChange={setProtocol}
            options={[
              {
                value: "ssh",
                label: "SSH shell",
                icon: <SquareTerminal size={14} aria-hidden="true" />,
              },
              {
                value: "sftp",
                label: "SFTP files",
                icon: <FolderOpen size={14} aria-hidden="true" />,
              },
            ]}
          />
          <p className="rename-dialog-hint" id={protocolHintId}>
            {protocol === "ssh"
              ? `A persistent tmux-backed shell on ${targetName}. It survives disconnects ` +
                "and reattaches automatically."
              : `An interactive sftp session on ${targetName} for browsing and ` +
                "transferring files. You can open shells in the group later."}
          </p>
        </div>

        {error ? (
          <p className="confirm-dialog-error" role="alert">
            {error}
          </p>
        ) : null}

        <DialogActions>
          <Button disabled={busy} onClick={onDismiss}>
            Cancel
          </Button>
          {/* While the add form is open, Enter saves the remote instead. */}
          <Button
            tone="primary"
            disabled={adding || !selectedRemote || busy}
            onClick={() => void createGroup()}
          >
            {creating ? "Creating…" : "Create group"}
          </Button>
        </DialogActions>
      </DialogForm>
    </DialogRoot>
  );
}
