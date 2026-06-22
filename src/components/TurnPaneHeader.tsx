import { Globe, Split, SquareCenterlineDashedVertical } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { writeClipboardText } from "../lib/clipboard";

// How long the "copied" toast stays up after clicking the session id.
const COPIED_TOAST_MS = 1600;

// The top bar across the right pane: the active session's id on the left, and on
// the right a fork control plus the browser toggle. Forking is only enabled for
// Claude sessions with a live id. Its height matches the browser overlay's address
// bar so the two read as a single chrome line when the browser is open.
interface TurnPaneHeaderProps {
  // The active agent's Claude session id, or null before SessionStart lands.
  sessionId: string | null;
  // Only Claude sessions with a valid session id can be forked.
  canFork: boolean;
  // Fork the session into a child tab of the current one, optionally in a fresh
  // git worktree.
  onFork: (options: { nest: boolean; useWorktree: boolean }) => void;
  showQueueSplit: boolean;
  queueSplit: boolean;
  onToggleQueueSplit: () => void;
  browserOpen: boolean;
  onToggleBrowser: () => void;
}

export default function TurnPaneHeader({
  sessionId,
  canFork,
  onFork,
  showQueueSplit,
  queueSplit,
  onToggleQueueSplit,
  browserOpen,
  onToggleBrowser,
}: TurnPaneHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

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

  const fork = (options: { nest: boolean; useWorktree: boolean }) => {
    setMenuOpen(false);
    onFork(options);
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
      {sessionId ? (
        <button
          type="button"
          className="turn-pane-session turn-pane-session-copy"
          title="Copy session id"
          onClick={() => void copySessionId()}
        >
          {`Session: ${sessionId}`}
        </button>
      ) : (
        <span className="turn-pane-session">New session</span>
      )}
      <div className="turn-pane-header-controls">
        <div className="turn-pane-fork" ref={menuRef}>
          <button
            type="button"
            className="turn-pane-header-button"
            disabled={!canFork}
            title={
              canFork
                ? "Fork session"
                : "Forking is available for Claude sessions after a session id is recorded"
            }
            aria-label="Fork session"
            aria-haspopup="menu"
            aria-expanded={canFork ? menuOpen : false}
            onClick={() => {
              if (canFork) {
                setMenuOpen((open) => !open);
              }
            }}
          >
            <Split size={14} aria-hidden="true" />
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
