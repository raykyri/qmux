import { Globe } from "lucide-react";
import type { PendingRemoteGroup as PendingGroup } from "../hooks/useRemoteGroupCreation";

export default function PendingRemoteGroup({ group }: { group: PendingGroup }) {
  return (
    <section
      className="pane-group is-pending"
      data-pending-remote-group-id={group.id}
      role="status"
      aria-live="polite"
    >
      <div className="pane-group-header">
        <span className="pane-group-title">
          <Globe className="pane-group-folder pane-group-remote-icon" size={13} aria-hidden="true" />
          <span className="pane-group-name">{group.label}</span>
        </span>
      </div>
      <div className="pane-group-pending-message">
        {group.protocol === "sftp" ? "Opening SFTP files…" : "Connecting SSH shell…"}
      </div>
    </section>
  );
}
