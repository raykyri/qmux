import { AlertTriangle, Clock3, Play } from "lucide-react";
import type { RecentSessionInfo, RuntimeConfig } from "../types";
import { formatRelativeTime } from "../lib/transcriptSessions";

interface RecentSessionsPanelProps {
  sessions: RecentSessionInfo[];
  config: RuntimeConfig | null;
  adapterIconById: Record<string, string>;
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

export default function RecentSessionsPanel({
  sessions,
  config,
  adapterIconById,
  onOpenSession,
  formatPath,
}: RecentSessionsPanelProps) {
  return (
    <section className="recent-sessions" aria-label="Recent sessions">
      <div className="recent-sessions-heading">
        <Clock3 size={14} aria-hidden="true" />
        <h2>Recent sessions</h2>
      </div>
      {sessions.length === 0 ? (
        <p className="recent-sessions-empty">No recent sessions</p>
      ) : (
        <div className="recent-sessions-list">
          {sessions.map((session) => {
            const icon = adapterIconById[session.adapter];
            const label = adapterLabel(config, session.adapter);
            const isOpen = Boolean(session.paneId);
            return (
              <button
                key={session.id}
                type="button"
                className="recent-session-row"
                disabled={session.missing}
                title={sessionTitle(session)}
                onClick={() => onOpenSession(session)}
              >
                <span className="recent-session-icon" title={label}>
                  {icon ? <img src={icon} alt="" /> : label.slice(0, 1).toUpperCase()}
                </span>
                <span className="recent-session-copy">
                  <span className="recent-session-title">{sessionTitle(session)}</span>
                  <span className="recent-session-meta">
                    {sessionMeta(session, formatPath)}
                  </span>
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
          })}
        </div>
      )}
    </section>
  );
}
