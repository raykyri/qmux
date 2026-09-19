import { RotateCw } from "lucide-react";
import type { ResearchHighlightFeedItem } from "../../types";
import { IS_MAC } from "../../lib/appHelpers";
import { formatRelativeTime } from "../../lib/transcriptSessions";
import Button from "../ui/Button";
import { ResearchDocumentFrame } from "./ResearchDocumentChrome";

export interface ResearchHighlightsFeedProps {
  items: ResearchHighlightFeedItem[];
  loading: boolean;
  error: string | null;
  onOpen: (item: ResearchHighlightFeedItem) => void;
  onRefresh: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
}

/** "Today", "Yesterday", or a calendar date for the feed's day headers. */
export function formatHighlightDayLabel(createdAt: number, now = Date.now()): string {
  const day = new Date(createdAt);
  const today = new Date(now);
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((startOfDay(today).getTime() - startOfDay(day).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

const CONTEXT_CHAR_LIMIT = 140;

/** Trim stored anchor context to a readable excerpt: the tail of the prefix
 * and the head of the suffix, cut at word boundaries. */
function excerptContext(text: string, side: "prefix" | "suffix", limit = CONTEXT_CHAR_LIMIT) {
  const collapsed = text.replace(/\s+/g, " ");
  if (collapsed.length <= limit) return collapsed;
  if (side === "prefix") {
    const tail = collapsed.slice(-limit);
    const cut = tail.indexOf(" ");
    return cut > 0 ? tail.slice(cut + 1) : tail;
  }
  const head = collapsed.slice(0, limit);
  const cut = head.lastIndexOf(" ");
  return cut > 0 ? head.slice(0, cut) : head;
}

/** Sidebar Highlights page: every saved highlight across open threads, newest
 * first under day headers. Each unit shows the passage inside its surrounding
 * sentence, with the highlighted span marked; opening it selects the thread at
 * that node and scrolls to the passage. */
export default function ResearchHighlightsFeed({
  items,
  loading,
  error,
  onOpen,
  onRefresh,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
}: ResearchHighlightsFeedProps) {
  let lastDay: string | null = null;
  return (
    <ResearchDocumentFrame
      title="Highlights"
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      backTitle={`Back (${IS_MAC ? "⌘[" : "Ctrl+["})`}
      forwardTitle={`Forward (${IS_MAC ? "⌘]" : "Ctrl+]"})`}
      onBack={onBack}
      onForward={onForward}
      navActions={
        <Button
          className="research-history-button"
          onClick={onRefresh}
          aria-label="Refresh Highlights"
          title="Refresh Highlights"
        >
          <RotateCw size={16} aria-hidden="true" />
        </Button>
      }
    >
      <div className="research-document-scroll journal-scroll">
        <div className="journal-column research-reading-surface research-highlights-column">
          {error ? (
            <div className="journal-empty-container">
              <p className="journal-empty" role="alert">
                {error}
              </p>
              <Button className="recent-activity-load-older" onClick={onRefresh}>
                Retry
              </Button>
            </div>
          ) : items.length === 0 ? (
            <div className="journal-empty-container">
              <p className="journal-empty">
                {loading
                  ? "Loading highlights…"
                  : "Text you highlight in research answers appears here, newest first."}
              </p>
            </div>
          ) : (
            <div
              className="research-highlights-list"
              role="feed"
              aria-label="Highlights"
              aria-busy={loading}
            >
              {items.map((item, index) => {
                const finiteTime = Number.isFinite(item.createdAt);
                const dayLabel = finiteTime ? formatHighlightDayLabel(item.createdAt) : null;
                const showDay = dayLabel !== null && dayLabel !== lastDay;
                if (dayLabel !== null) lastDay = dayLabel;
                const label =
                  item.nodeLabel && item.nodeLabel !== item.treeTitle
                    ? `${item.treeTitle} › ${item.nodeLabel}`
                    : item.treeTitle;
                const prefix = excerptContext(item.prefix, "prefix");
                const suffix = excerptContext(item.suffix, "suffix");
                const open = () => onOpen(item);
                return (
                  <article
                    key={item.highlightId}
                    className="research-highlight-unit"
                    aria-posinset={index + 1}
                    aria-setsize={items.length}
                  >
                    {showDay ? <div className="research-highlight-day">{dayLabel}</div> : null}
                    <div
                      className="research-highlight-excerpt"
                      role="button"
                      tabIndex={0}
                      title="Open in thread"
                      onClick={open}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        open();
                      }}
                    >
                      {prefix ? (
                        <span className="research-highlight-context">{`…${prefix}`}</span>
                      ) : null}
                      <mark className="research-highlight-mark">{item.exact}</mark>
                      {suffix ? (
                        <span className="research-highlight-context">{`${suffix}…`}</span>
                      ) : null}
                    </div>
                    <div
                      className="research-highlight-footer"
                      title={finiteTime ? new Date(item.createdAt).toLocaleString() : undefined}
                    >
                      <Button className="research-highlight-source" onClick={open}>
                        {label}
                      </Button>
                      {finiteTime ? (
                        <time dateTime={new Date(item.createdAt).toISOString()}>
                          {formatRelativeTime(item.createdAt)}
                        </time>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </ResearchDocumentFrame>
  );
}
