import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { COLLAPSED_IMAGE_LABEL, splitImageMarkers } from "../lib/imageMarkers";
import type { QueuedTurnDelivery } from "../types";
import TranscriptImage from "./TranscriptImage";

// Terminal title progress markers tend to be leading glyphs and spacing; strip
// those only for the queued-turn wait footer so the stored wait target stays raw.
const WAIT_TITLE_PROGRESS_PREFIX_RE =
  /^[ \t·•●○◦∙⋅⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✢✣✤✥✦✧✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿\uFE0E\uFE0F]+/u;

export function waitFooterTitle(label: string) {
  return label.replace(WAIT_TITLE_PROGRESS_PREFIX_RE, "").trim() || label.trim();
}

export function waitFooterLabelWithShortcut(label: string, shortcutLabel?: string | null) {
  const quotedTitle = `"${waitFooterTitle(label)}"`;
  return shortcutLabel ? `${quotedTitle} (${shortcutLabel})` : quotedTitle;
}

export function queuedTurnDeliveryLabel(delivery: QueuedTurnDelivery) {
  if (delivery.kind === "newSession") {
    return "To new session";
  }
  return delivery.useWorktree ? "Fork in worktree" : "Fork session";
}

/** Image paste markers render as a muted "[Image]" chip instead of the raw
 *  image-cache path — shared by the composer queue and the home rails so both
 *  read the same. Pass the stored text; drags and queue commands must keep
 *  using the raw text, never this rendering.
 *
 *  With `imageThumbnails`, source-path markers render as a small clickable
 *  preview (home rails) instead of the chip; pathless "[Image #N]" refs still
 *  fall back to the chip. The composer queue leaves it off and keeps chips. */
export function renderQueuedTurnText(
  text: string,
  options?: { imageThumbnails?: boolean },
): ReactNode {
  const segments = splitImageMarkers(text);
  if (segments.length === 1 && segments[0].kind !== "image") {
    return text;
  }
  return segments.map((segment, index) =>
    segment.kind === "image" ? (
      options?.imageThumbnails ? (
        <TranscriptImage key={index} marker={segment.text} variant="thumbnail" />
      ) : (
        <span key={index} className="queued-turn-image-chip">
          {COLLAPSED_IMAGE_LABEL}
        </span>
      )
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  );
}

/** How the card reads in a queue column:
 *  - "queued": a pending turn (the composer's queue and home rails).
 *  - "current": the turn an agent is working on now (home rails only).
 *  - "past": an already-settled turn, grayed out (home rails only). */
export type QueuedTurnCardVariant = "queued" | "current" | "past";

/** Border tone for the "current" variant, mirroring agent status. */
export type QueuedTurnCardTone = "active" | "done" | "attention" | "error";

interface QueuedTurnCardProps {
  text: ReactNode;
  variant?: QueuedTurnCardVariant;
  tone?: QueuedTurnCardTone | null;
  pauseAfter?: boolean;
  /** Delivery pill caption (see queuedTurnDeliveryLabel); no pill when null. */
  deliveryLabel?: string | null;
  /** Wait pill content; the card border also goes dashed while present. */
  waitLabel?: ReactNode;
  onWaitHoverChange?: (hovering: boolean) => void;
  /** Plain meta row under the text ("✓ 2h ago", "● working · 4m"). */
  receipt?: ReactNode;
  /** Right-column action buttons (the composer's remove/edit). */
  actions?: ReactNode;
  /** Owner-managed state classes (drag/drop rules). */
  className?: string;
  ref?: Ref<HTMLDivElement>;
  role?: string;
  tabIndex?: number;
  onClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onTextDoubleClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

export function QueuedTurnCard({
  text,
  variant = "queued",
  tone,
  pauseAfter,
  deliveryLabel,
  waitLabel,
  onWaitHoverChange,
  receipt,
  actions,
  className,
  ref,
  role,
  tabIndex,
  onClick,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onTextDoubleClick,
}: QueuedTurnCardProps) {
  const rootClassName = [
    "queued-turn",
    waitLabel != null ? "has-wait" : "",
    variant === "current" ? "is-current" : "",
    variant === "past" ? "is-past" : "",
    variant === "current" && tone ? `tone-${tone}` : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      ref={ref}
      className={rootClassName}
      role={role}
      tabIndex={tabIndex}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div className="queued-turn-text" onDoubleClick={onTextDoubleClick}>
        {text}
      </div>
      {actions != null ? <div className="queued-turn-actions">{actions}</div> : null}
      {pauseAfter ? (
        <div className="queued-turn-pause-label" aria-hidden="true">
          Pause after send
        </div>
      ) : null}
      {deliveryLabel ? (
        <div className="queued-turn-delivery-label" aria-hidden="true">
          {deliveryLabel}
        </div>
      ) : null}
      {waitLabel != null ? (
        <div
          className="queued-turn-wait-label"
          aria-hidden="true"
          onPointerEnter={onWaitHoverChange ? () => onWaitHoverChange(true) : undefined}
          onPointerLeave={onWaitHoverChange ? () => onWaitHoverChange(false) : undefined}
        >
          {waitLabel}
        </div>
      ) : null}
      {receipt != null ? <div className="queued-turn-receipt">{receipt}</div> : null}
    </div>
  );
}
