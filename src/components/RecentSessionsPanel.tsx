import { useState } from "react";
import { AlertTriangle, Clock3, Play, SquareStack } from "lucide-react";
import type { QueuedTurn, RecentSessionInfo, RuntimeConfig } from "../types";
import { formatRelativeTime } from "../lib/transcriptSessions";

const RECENT_SESSION_COLLAPSED_LIMIT = 2;

interface RecentSessionsPanelProps {
  sessions: RecentSessionInfo[];
  config: RuntimeConfig | null;
  adapterIconById: Record<string, string>;
  adapterIconClassById?: Record<string, string | undefined>;
  queuedTurnsByAgent: Record<string, QueuedTurn[]>;
  onOpenSession: (session: RecentSessionInfo) => void;
  formatPath: (path: string) => string;
}

function sessionTitle(session: RecentSessionInfo): string {
  const preview = session.preview?.trim();
  if (preview) {
    return preview;
  }
  const shortId = session.sessionId?.split("-")[0];
  return shortId ? `Session ${shortId}` : "Untitled session";
}

function adapterLabel(config: RuntimeConfig | null, adapterId: string): string {
  return config?.adapters.find((adapter) => adapter.id === adapterId)?.label ?? adapterId;
}

function sessionMeta(session: RecentSessionInfo, formatPath: (path: string) => string): string {
  const parts = [formatRelativeTime(session.lastActiveAt), formatPath(session.worktreeDir)];
  if (session.model) {
    parts.push(session.model);
  }
  return parts.join(" · ");
}

// A read-only rendering of a session's queued turns using the same card markup as
// the right sidebar's composer (NativeInput). Each card starts collapsed here and
// can be clicked to expand, since the home surface lists many sessions at once.
function SessionQueueCards({ turns }: { turns: QueuedTurn[] }) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  if (turns.length === 0) {
    return null;
  }

  return (
    <div className="queued-turn-stack open-tab-queue" aria-label="Queued turns">
      {turns.map((turn, index) => {
        const collapsed = !expanded[index];
        return (
          <div
            key={`${index}-${turn.text}`}
            className={`queued-turn${collapsed ? " is-collapsed" : ""}`}
          >
            <button
              type="button"
              className="queued-turn-toggle"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand queued turn" : "Collapse queued turn"}
              onClick={() =>
                setExpanded((prev) => ({ ...prev, [index]: !prev[index] }))
              }
            >
              <span className="queued-turn-text">{turn.text}</span>
            </button>
            {turn.pauseAfter ? (
              <div className="queued-turn-pause-label" aria-hidden="true">
                Pause after send
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default function RecentSessionsPanel({
  sessions,
  config,
  adapterIconById,
  adapterIconClassById = {},
  queuedTurnsByAgent,
  onOpenSession,
  formatPath,
}: RecentSessionsPanelProps) {
  const [showAllRecentSessions, setShowAllRecentSessions] = useState(false);
  // "Open tabs" are sessions currently bound to a live pane; the rest are history.
  // Each session appears in exactly one of the two sections, never both.
  const openSessions = sessions.filter((session) => Boolean(session.paneId));
  const recentSessions = sessions.filter((session) => !session.paneId);
  const visibleRecentSessions = showAllRecentSessions
    ? recentSessions
    : recentSessions.slice(0, RECENT_SESSION_COLLAPSED_LIMIT);
  const hiddenRecentSessionCount = recentSessions.length - visibleRecentSessions.length;

  function renderRow(session: RecentSessionInfo) {
    const icon = adapterIconById[session.adapter];
    const iconClassName = adapterIconClassById[session.adapter];
    const label = adapterLabel(config, session.adapter);
    const isOpen = Boolean(session.paneId);
    return (
      <button
        type="button"
        className="recent-session-row"
        disabled={session.missing}
        title={sessionTitle(session)}
        onClick={() => onOpenSession(session)}
      >
        <span className="recent-session-icon" title={label}>
          {icon ? (
            <img className={iconClassName} src={icon} alt="" />
          ) : (
            label.slice(0, 1).toUpperCase()
          )}
        </span>
        <span className="recent-session-copy">
          <span className="recent-session-title">{sessionTitle(session)}</span>
          <span className="recent-session-meta">{sessionMeta(session, formatPath)}</span>
        </span>
        {session.missing ? (
          <span className="recent-session-badge recent-session-badge--warning">
            <AlertTriangle size={12} aria-hidden="true" />
            Missing
          </span>
        ) : isOpen ? (
          <span className="recent-session-badge">Open</span>
        ) : (
          <Play size={13} aria-hidden="true" className="recent-session-open-icon" />
        )}
      </button>
    );
  }

  return (
    <div className="recent-sessions-module">
      {openSessions.length > 0 ? (
        <section className="recent-sessions open-tabs" aria-label="Open tabs">
          <div className="recent-sessions-heading">
            <SquareStack size={14} aria-hidden="true" />
            <h2>Open tabs</h2>
          </div>
          <div className="recent-sessions-list">
            {openSessions.map((session) => {
              const turns = session.agentId
                ? queuedTurnsByAgent[session.agentId] ?? []
                : [];
              return (
                <div key={session.id} className="open-tab-entry">
                  {renderRow(session)}
                  <SessionQueueCards turns={turns} />
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="recent-sessions" aria-label="Recent sessions">
        <div className="recent-sessions-heading">
          <Clock3 size={14} aria-hidden="true" />
          <h2>Recent sessions</h2>
        </div>
        {recentSessions.length === 0 ? (
          <p className="recent-sessions-empty">No recent sessions</p>
        ) : (
          <div className="recent-sessions-list">
            {visibleRecentSessions.map((session) => (
              <div key={session.id}>{renderRow(session)}</div>
            ))}
          </div>
        )}
        {hiddenRecentSessionCount > 0 ? (
          <button
            type="button"
            className="recent-sessions-show-more"
            aria-label={`Show ${hiddenRecentSessionCount} more recent ${
              hiddenRecentSessionCount === 1 ? "session" : "sessions"
            }`}
            onClick={() => setShowAllRecentSessions(true)}
          >
            Show {hiddenRecentSessionCount} more
          </button>
        ) : null}
      </section>
    </div>
  );
}
