import {
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  beginPublishingAuth,
  disconnectPublishingAuth,
  getPublishingAuthStatus,
  openExternalUrl,
  pollPublishingAuth,
  publishPublication,
  syncPublication,
} from "../lib/api";
import { writeClipboardText } from "../lib/clipboard";
import type {
  PublicationBinding,
  PublicationDraft,
  PublishingAuthStatus,
  PublishingDeviceAuthorization,
} from "../lib/publication";

export interface PublishDialogTarget {
  kindLabel: string;
  initialTitle: string;
  previewText: string;
  binding?: PublicationBinding | null;
  buildDraft: (title: string) => Promise<PublicationDraft>;
}

interface PublishDialogProps {
  target: PublishDialogTarget | null;
  onClose: () => void;
  onPublished: (binding: PublicationBinding) => void;
}

export default function PublishDialog({
  target,
  onClose,
  onPublished,
}: PublishDialogProps) {
  const [title, setTitle] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [auth, setAuth] = useState<PublishingAuthStatus | null>(null);
  const [authorization, setAuthorization] =
    useState<PublishingDeviceAuthorization | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<PublicationBinding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const busy = loadingAuth || publishing;
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!target) {
      return;
    }
    setTitle(target.initialTitle);
    setIsPublic(target.binding?.isPublic ?? false);
    setAuthorization(null);
    setPublishing(false);
    setResult(null);
    setError(null);
    setCopied(null);
    setLoadingAuth(true);
    void getPublishingAuthStatus()
      .then(setAuth)
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setLoadingAuth(false));
    const frame = requestAnimationFrame(() => {
      titleRef.current?.focus();
      titleRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);

  useEffect(() => {
    if (!authorization || auth?.connected) {
      return;
    }
    let disposed = false;
    let timer: number | null = null;
    let intervalSeconds = authorization.intervalSeconds;
    const poll = async () => {
      if (disposed) {
        return;
      }
      if (Date.now() >= authorization.expiresAt) {
        setAuthorization(null);
        setError("The GitHub authorization code expired. Start again.");
        return;
      }
      try {
        const response = await pollPublishingAuth(authorization.deviceCode);
        if (disposed) {
          return;
        }
        if (response.status === "connected") {
          setAuth(response.account);
          setAuthorization(null);
          setError(null);
          return;
        }
        intervalSeconds = response.intervalSeconds;
      } catch (reason) {
        if (!disposed) {
          setAuthorization(null);
          setError(errorMessage(reason));
        }
        return;
      }
      timer = window.setTimeout(poll, Math.max(1, intervalSeconds) * 1_000);
    };
    timer = window.setTimeout(poll, Math.max(1, intervalSeconds) * 1_000);
    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [auth?.connected, authorization]);

  useEffect(() => {
    if (!target) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busyRef.current) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [target]);

  if (!target) {
    return null;
  }

  const activeTarget = target;
  const updating = Boolean(activeTarget.binding);
  const canPublish = Boolean(title.trim()) && auth?.connected === true && !busy;

  async function connect() {
    setLoadingAuth(true);
    setError(null);
    try {
      const next = await beginPublishingAuth();
      setAuthorization(next);
      await openExternalUrl(next.verificationUri);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoadingAuth(false);
    }
  }

  async function disconnect() {
    setLoadingAuth(true);
    setError(null);
    try {
      setAuthorization(null);
      setAuth(await disconnectPublishingAuth());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoadingAuth(false);
    }
  }

  async function publish() {
    if (!canPublish) {
      return;
    }
    setPublishing(true);
    setError(null);
    try {
      const draft = await activeTarget.buildDraft(title.trim());
      const binding = activeTarget.binding
        ? await syncPublication({
            publicationId: draft.publication.publicationId,
            title: draft.publication.title,
            isPublic: activeTarget.binding.isPublic,
            files: draft.files,
            source: draft.source,
            publicNodeIds: draft.publicNodeIds,
          })
        : await publishPublication({
            publicationId: draft.publication.publicationId,
            title: draft.publication.title,
            isPublic,
            files: draft.files,
            source: draft.source,
            publicNodeIds: draft.publicNodeIds,
          });
      setResult(binding);
      onPublished(binding);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPublishing(false);
    }
  }

  async function copy(value: string, type: "code" | "link") {
    try {
      await writeClipboardText(value);
      setCopied(type);
      window.setTimeout(() => setCopied((current) => (current === type ? null : current)), 1_500);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  return (
    <div
      className="confirm-dialog-backdrop publication-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <section
        className="publication-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="publication-dialog-title"
      >
        <header className="publication-dialog-header">
          <div>
            <p className="publication-dialog-kicker">
              {updating ? "Update" : "Publish"} {target.kindLabel}
            </p>
            <h2 id="publication-dialog-title">GitHub Gist</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close publish dialog"
            title="Close"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        {result ? (
          <div className="publication-success">
            <div className="publication-success-mark" aria-hidden="true">
              <Check size={18} />
            </div>
            <div>
              <h3>{updating ? "Updated" : "Published"}</h3>
              <p>{result.isPublic ? "Public Gist" : "Secret Gist"}</p>
            </div>
            <div className="publication-link-row">
              <input readOnly value={result.shareUrl} aria-label="Published qmux URL" />
              <button
                type="button"
                className="icon-button"
                aria-label="Copy published URL"
                title="Copy link"
                onClick={() => void copy(result.shareUrl, "link")}
              >
                {copied === "link" ? (
                  <Check size={15} aria-hidden="true" />
                ) : (
                  <Copy size={15} aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Open published URL"
                title="Open published page"
                onClick={() => void openExternalUrl(result.shareUrl)}
              >
                <ExternalLink size={15} aria-hidden="true" />
              </button>
            </div>
            {result.warning ? (
              <p className="publication-warning" role="status">
                {result.warning}
              </p>
            ) : null}
            <div className="publication-dialog-actions">
              <button type="button" className="control-button" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="publication-dialog-body">
              <label className="publication-field">
                <span>Title</span>
                <input
                  ref={titleRef}
                  value={title}
                  maxLength={240}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                />
              </label>

              <fieldset className="publication-visibility" disabled={updating}>
                <legend>Visibility</legend>
                <div className="publication-segmented-control">
                  <label className={!isPublic ? "is-selected" : undefined}>
                    <input
                      type="radio"
                      name="publication-visibility"
                      checked={!isPublic}
                      onChange={() => setIsPublic(false)}
                    />
                    <LockKeyhole size={14} aria-hidden="true" />
                    Secret
                  </label>
                  <label className={isPublic ? "is-selected" : undefined}>
                    <input
                      type="radio"
                      name="publication-visibility"
                      checked={isPublic}
                      onChange={() => setIsPublic(true)}
                    />
                    <Globe2 size={14} aria-hidden="true" />
                    Public
                  </label>
                </div>
                <p>
                  {updating
                    ? "Visibility stays unchanged when an existing Gist is updated."
                    : isPublic
                    ? "Public Gists appear in discovery and on your GitHub profile."
                    : "Secret Gists are unlisted, not private. Anyone with the link can read them."}
                </p>
              </fieldset>

              <div className="publication-preview">
                <div className="publication-preview-heading">
                  <span>Published content</span>
                  <span>{target.previewText.length.toLocaleString()} characters</span>
                </div>
                <pre>{target.previewText}</pre>
              </div>

              <div className="publication-account">
                <div className="publication-account-icon" aria-hidden="true">
                  <GitBranch size={17} />
                </div>
                <div className="publication-account-copy">
                  <strong>
                    {auth?.connected
                      ? auth.login
                        ? `Connected as ${auth.login}`
                        : "GitHub connected"
                      : "GitHub account"}
                  </strong>
                  {!auth?.connected && !authorization ? (
                    <span>
                      {auth?.configured === false
                        ? "OAuth client ID is not configured in this build."
                        : "Required to create the Gist."}
                    </span>
                  ) : null}
                  {authorization ? (
                    <span>Enter this code on GitHub to continue.</span>
                  ) : null}
                </div>
                {auth?.connected ? (
                  <button
                    type="button"
                    className="control-button publication-account-action"
                    disabled={busy}
                    onClick={() => void disconnect()}
                  >
                    Disconnect
                  </button>
                ) : authorization ? (
                  <div className="publication-device-code">
                    <code>{authorization.userCode}</code>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Copy GitHub device code"
                      title="Copy code"
                      onClick={() => void copy(authorization.userCode, "code")}
                    >
                      {copied === "code" ? (
                        <Check size={14} aria-hidden="true" />
                      ) : (
                        <Copy size={14} aria-hidden="true" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Open GitHub authorization"
                      title="Open GitHub"
                      onClick={() => void openExternalUrl(authorization.verificationUri)}
                    >
                      <ExternalLink size={14} aria-hidden="true" />
                    </button>
                    <LoaderCircle className="publication-spinner" size={15} aria-hidden="true" />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="control-button publication-account-action"
                    disabled={busy || auth?.configured === false}
                    onClick={() => void connect()}
                  >
                    <GitBranch size={14} aria-hidden="true" />
                    Connect
                  </button>
                )}
              </div>

              {error ? (
                <p className="publication-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>

            <footer className="publication-dialog-footer">
              <div className="publication-dialog-actions">
                <button
                  type="button"
                  className="control-button"
                  disabled={busy}
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="control-button primary"
                  disabled={!canPublish}
                  onClick={() => void publish()}
                >
                  {publishing ? (
                    <LoaderCircle className="publication-spinner" size={14} aria-hidden="true" />
                  ) : (
                    <Globe2 size={14} aria-hidden="true" />
                  )}
                  {updating ? "Update" : "Publish"}
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
