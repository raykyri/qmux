import { findAgentUiAdapter } from "../adapters";
import type { ActivityEvent } from "../lib/activity";
import {
  CUSTOM_MODEL,
  formatLauncherModelLabel,
  modelPresetsFor,
} from "../lib/launcherModels";
import { formatRelativeTime } from "../lib/transcriptSessions";

function adapterDisplayLabel(adapter: string): string {
  if (!adapter) return "";
  return findAgentUiAdapter(adapter)?.label ?? formatLauncherModelLabel(adapter, adapter);
}

/** Preset names like Fable/Opus. Product ids (`gpt-5.6-sol`) and custom
 * slugs are omitted so the line can fall back to just the adapter. */
function humanReadableModelName(adapter: string, model?: string | null): string | null {
  if (!model || model === CUSTOM_MODEL) return null;
  if (!modelPresetsFor(adapter).includes(model)) return null;
  const label = formatLauncherModelLabel(adapter, model);
  if (/[\d._-]/.test(label)) return null;
  return label;
}

/** The model that answered a thread's root prompt, as "Claude Fable" or just
 * "Claude" when the model id has no preset name. Empty for unknown adapters. */
export function formatResearchModelSummary(
  adapter: string,
  model?: string | null,
  origin?: string | null,
): string {
  if (origin === "imported") return "Imported";
  const adapterLabel = adapterDisplayLabel(adapter);
  const modelName = humanReadableModelName(adapter, model);
  if (adapterLabel && modelName) return `${adapterLabel} ${modelName}`;
  return adapterLabel;
}

/** Concise action label for Home's chronological feed. The content card carries
 * the provider/object details, so this line only orients the reader in time and
 * names the containing thread when a reply belongs to one. */
export function formatActivityMetadataSummary(event: ActivityEvent): string {
  if (event.object.kind === "research-query") {
    if (event.execution?.origin === "imported") return "Imported";
    if (event.relationship?.kind === "follow-up") {
      return `Replied in “${event.context?.label ?? "Research"}”`;
    }
    return "";
  }
  if (event.action.kind === "saved") {
    return "Saved";
  }
  const label = event.action.label.trim();
  return label ? `${label[0].toUpperCase()}${label.slice(1)}` : "Activity";
}

/** Renderer for activity grammar slots. Metadata stays outside the
 * content surface because it describes the event, not the object payload. */
export default function ActivityMetadataLine({ event }: { event: ActivityEvent }) {
  const finiteTime = Number.isFinite(event.occurredAt);
  const summary = formatActivityMetadataSummary(event);
  return (
    <div
      className="activity-metadata"
      title={finiteTime ? new Date(event.occurredAt).toLocaleString() : undefined}
    >
      <span className="activity-metadata-summary">
        {summary}
        {finiteTime ? (
          <>
            {summary ? " " : null}
            <time dateTime={new Date(event.occurredAt).toISOString()}>
              {formatRelativeTime(event.occurredAt)}
            </time>
          </>
        ) : null}
      </span>
    </div>
  );
}
