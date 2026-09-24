import { Check, Minus, X } from "lucide-react";
import type { RemoteProbeCheck } from "../types";

/** The per-check rows from a remote connection test (ssh, tmux, qmux-cli). */
export default function RemoteProbeChecks({ checks }: { checks: RemoteProbeCheck[] }) {
  return (
    <div className="settings-remote-checks">
      {checks.map((check) => (
        <div className={`settings-remote-check is-${check.status}`} key={check.id}>
          {check.status === "passed" ? (
            <Check size={13} aria-hidden="true" />
          ) : check.status === "failed" ? (
            <X size={13} aria-hidden="true" />
          ) : (
            <Minus size={13} aria-hidden="true" />
          )}
          <span>
            <strong>{check.label}</strong>
            <small>{check.message}</small>
          </span>
        </div>
      ))}
    </div>
  );
}
