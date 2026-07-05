import {
  Expand,
  GitBranch,
  Globe,
  Minimize2,
  PanelRightClose,
  SquareCenterlineDashedVertical,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { writeClipboardText } from "../lib/clipboard";
import { formatRelativeTime, sessionMenuTitle } from "../lib/transcriptSessions";
import type { TranscriptOption } from "../types";

// How long the "copied" toast stays up after copying the session id.
const COPIED_TOAST_MS = 1600;

// The top bar across the right pane: the active session's id on the left, and
// session/browser/transcript controls on the right. Forking is only enabled for
// supported sessions with a live id. Its height matches the browser overlay's
// address bar so the two read as a single chrome line when the browser is open.
interface TurnPaneHeaderProps {
  // The active agent's session id, or null before SessionStart lands.
  sessionId: string | null;
  // Sessions in this agent's folder for the top-left session switcher; the
  // active one is whichever matches transcriptPath.
  transcriptOptions: TranscriptOption[];
  transcriptPath: string | null;
  onSelectTranscript: (path: string | null) => void;
  // Only supported sessions with a valid session id can be forked.
  canFork: boolean;
  // Fork the session into a child tab of the current one, optionally in a fresh
  // git worktree.
  onFork: (options: { nest: boolean; useWorktree: boolean }) => void;
  showQueueSplit: boolean;
  queueSplit: boolean;
  onToggleQueueSplit: () => void;
  browserOpen: boolean;
  onToggleBrowser: () => void;
  transcriptExpanded: boolean;
  transcriptShortcutLabel: string;
  onToggleTranscriptExpanded: () => void;
  onCollapseRightBar: () => void;
}

export default function TurnPaneHeader({
  sessionId,
  transcriptOptions,
  transcriptPath,
  onSelectTranscript,
  canFork,
  onFork,
  showQueueSplit,
  queueSplit,
  onToggleQueueSplit,
  browserOpen,
  onToggleBrowser,
  transcriptExpanded,
  transcriptShortcutLabel,
  onToggleTranscriptExpanded,
  onCollapseRightBar,
}: TurnPaneHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  // Sorted newest first so recent sessions appear at the top of the menu.
  const sessionOptions = [...transcriptOptions].sort((a, b) => b.modifiedMs - a.modifiedMs);
  const canOpenSessionMenu = Boolean(sessionId || sessionOptions.length > 0);

  // Clear any pending toast timer on unmount so it can't fire into a gone component.
  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) {
        window.clearTimeout(toastTimer.current);
      }
    };
  }, []);

  // Close the fork menu on an outside click or Escape while it is open.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!canFork) {
      setMenuOpen(false);
    }
  }, [canFork]);

  // Close the session menu on an outside click or Escape while it is open.
  useEffect(() => {
    if (!sessionMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (
        sessionMenuRef.current &&
        !sessionMenuRef.current.contains(event.target as Node)
      ) {
        setSessionMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSessionMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [sessionMenuOpen]);

  useEffect(() => {
    if (!canOpenSessionMenu) {
      setSessionMenuOpen(false);
    }
  }, [canOpenSessionMenu]);

  const fork = (options: { nest: boolean; useWorktree: boolean }) => {
    setMenuOpen(false);
    onFork(options);
  };

  const selectTranscript = (path: string | null) => {
    setSessionMenuOpen(false);
    onSelectTranscript(path);
  };

  const copySessionId = async () => {
    if (!sessionId) {
      return;
    }
    try {
      await writeClipboardText(sessionId);
      setToast("Copied session id");
    } catch {
      setToast("Couldn’t copy session id");
    }
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, COPIED_TOAST_MS);
  };

  return (
    <div className="turn-pane-header">
      <div className="turn-pane-session-control" ref={sessionMenuRef}>
        {canOpenSessionMenu ? (
          <button
            type="button"
            className="turn-pane-session turn-pane-session-trigger"
            title="Session actions"
            aria-haspopup="menu"
            aria-expanded={sessionMenuOpen}
            onClick={() => {
              setMenuOpen(false);
              setSessionMenuOpen((open) => !open);
            }}
          >
            {sessionId ? `Session: ${sessionId}` : "New session"}
          </button>
        ) : (
          <span className="turn-pane-session">New session</span>
        )}
        {sessionMenuOpen ? (
          <div className="turn-pane-session-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="turn-pane-session-menu-item"
              disabled={!sessionId}
              onClick={() => {
                setSessionMenuOpen(false);
                void copySessionId();
              }}
            >
              Copy Session ID
            </button>
            {sessionOptions.length > 0 ? (
              <>
                <div className="turn-pane-session-menu-divider" role="separator" />
                <div className="turn-pane-session-menu-label">Select Session</div>
                <div
                  className="turn-pane-session-list"
                  role="group"
                  aria-label="Select Session"
                >
                  {sessionOptions.map((option) => {
                    const active = option.path === transcriptPath;
                    return (
                      <button
                        key={option.path}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={active}
                        className={`turn-pane-session-menu-item session-menu-item${
                          active ? " is-active" : ""
                        }`}
                        onClick={() => selectTranscript(active ? null : option.path)}
                      >
                        <span className="session-menu-title">{sessionMenuTitle(option)}</span>
                        <span className="session-menu-meta">
                          {formatRelativeTime(option.modifiedMs)}
                          {option.boundToOtherAgent ? " · In use" : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="turn-pane-header-controls">
        <div className="turn-pane-fork" ref={menuRef}>
          <button
            type="button"
            className="turn-pane-header-button"
            disabled={!canFork}
            title={
              canFork
                ? "Fork session"
                : "Forking is available after a supported session id is recorded"
            }
            aria-label="Fork session"
            aria-haspopup="menu"
            aria-expanded={canFork ? menuOpen : false}
            onClick={() => {
              if (canFork) {
                setSessionMenuOpen(false);
                setMenuOpen((open) => !open);
              }
            }}
          >
            <GitBranch size={14} aria-hidden="true" />
          </button>
          {canFork && menuOpen ? (
            <div className="turn-pane-fork-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="turn-pane-fork-item"
                onClick={() => fork({ nest: true, useWorktree: false })}
              >
                Fork session
              </button>
              <button
                type="button"
                role="menuitem"
                className="turn-pane-fork-item"
                onClick={() => fork({ nest: true, useWorktree: true })}
              >
                Fork session in worktree
              </button>
            </div>
          ) : null}
        </div>
        {showQueueSplit ? (
          <button
            type="button"
            className={`turn-pane-header-button${queueSplit ? " is-active" : ""}`}
            title={queueSplit ? "Use floating queue" : "Split transcript and queue"}
            aria-label={queueSplit ? "Use floating queue" : "Split transcript and queue"}
            aria-pressed={queueSplit}
            onClick={onToggleQueueSplit}
          >
            <SquareCenterlineDashedVertical size={14} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className={`turn-pane-header-button${browserOpen ? " is-active" : ""}`}
          title={browserOpen ? "Hide browser" : "Show browser"}
          aria-label={browserOpen ? "Hide browser" : "Show browser"}
          aria-pressed={browserOpen}
          onClick={onToggleBrowser}
        >
          <Globe size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`turn-pane-header-button${transcriptExpanded ? " is-active" : ""}`}
          title={
            `${transcriptExpanded ? "Restore transcript" : "Expand transcript"} (${transcriptShortcutLabel})`
          }
          aria-label={transcriptExpanded ? "Restore transcript" : "Expand transcript"}
          aria-pressed={transcriptExpanded}
          onClick={onToggleTranscriptExpanded}
        >
          {transcriptExpanded ? (
            <Minimize2 size={14} aria-hidden="true" />
          ) : (
            <Expand size={14} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="turn-pane-header-button"
          title="Collapse right bar"
          aria-label="Collapse right bar"
          onClick={onCollapseRightBar}
        >
          <PanelRightClose size={14} aria-hidden="true" />
        </button>
      </div>
      {/* Portaled to <body> so the fixed-position toast escapes the header's
          stacking context (position:absolute + z-index), which would otherwise
          trap it and keep it from showing — unlike the composer toast, whose
          wrapper sets no z-index. */}
      {toast
        ? createPortal(
            <div className="composer-toast" role="status" aria-live="polite">
              {toast}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
