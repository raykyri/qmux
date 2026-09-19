import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FocusEvent, MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Copy,
  ExternalLink,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RotateCw,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  recentActivityItemId,
  type JournalEntry,
  type JournalTweetEntry,
  type RecentActivityItem,
} from "../../lib/journal";
import {
  buildRecentActivityFromItems,
  type RecentActivityEvent,
} from "../../lib/activity";
import type {
  RecentActivityCursor,
  RecentResearchQuery,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeSummary,
} from "../../types";
import { IS_MAC, isEditableTarget } from "../../lib/appHelpers";
import { getResearchNodeContent, openExternalUrl } from "../../lib/api";
import { writeClipboardText } from "../../lib/clipboard";
import type { ResearchFolderState } from "../../lib/researchFolders";
import { isActiveResearchStatus } from "../../lib/researchThreads";
import { useResearchSwipeNavigation } from "../../hooks/useResearchSwipeNavigation";
import { TweetEmbed } from "./TweetEmbed";
import { ResearchDocumentFrame } from "./ResearchDocumentChrome";
import ActivityMetadataLine from "../ActivityMetadataLine";
import ResearchThreadActions from "./ResearchThreadActions";
import { ResearchRecapLine, ResearchRecapPendingLine } from "./ResearchRecap";
import ResearchRecapDialog from "./ResearchRecapDialog";
import { ResearchMessageBody, ResearchUserMessage } from "./ResearchMessage";
import {
  RESEARCH_TREE_MENU_WIDTH,
  ResearchTreeDeleteDialog,
  ResearchTreeMenuItems,
  ResearchTreeRenameDialog,
} from "./ResearchTreeMenu";
import {
  Button,
  DialogActions,
  DialogForm,
  DialogRoot,
  DialogTitle,
  Input,
  Menu,
  MenuItem,
  PopoverPortal,
  useAnchoredPopover,
} from "../ui";

/** Scroll anchor tracking the row key under the top edge of the viewport and
 * its pixel offset. */
export interface RecentActivityScrollAnchor {
  key: string;
  offset: number;
}

/** Where an anchored row sits relative to the viewport's top edge. */
export function recentActivityAnchorOffset(
  canvasTop: number,
  rowOffset: number,
  scrollTop: number,
): number {
  return canvasTop + rowOffset - scrollTop;
}

/** The scrollTop that restores an anchored row to its saved offset. */
export function recentActivityAnchorScrollTop(
  canvasTop: number,
  rowOffset: number,
  anchorOffset: number,
): number {
  return Math.max(0, canvasTop + rowOffset - anchorOffset);
}

export type ResearchActivityFeedView = "home" | "bookmarks";

const EMPTY_RECAP_PENDING_NODE_IDS: ReadonlySet<string> = new Set<string>();

export interface ResearchActivityFeedProps {
  /** The Home query composer, rendered above the first feed row. */
  composer: ReactNode;
  /** The anchor to restore on mount. Read once: the feed owns its scroll
   * position afterwards and reports it through onScrollAnchorChange. */
  initialScrollAnchor?: RecentActivityScrollAnchor | null;
  onScrollAnchorChange?: (anchor: RecentActivityScrollAnchor | null) => void;
  /** Home lists every item; Bookmarks lists only queries whose thread is
   * bookmarked, without the composer or the setup guide. */
  view?: ResearchActivityFeedView;
  /** Replaces the empty-state sentence when the Home feed has no rows. */
  setupGuide?: ReactNode;
  /** Imports a Markdown report as a research thread. Declared here so the
   * feed's header slot has a home for it; the control lands with report
   * import. */
  onImportReport?: (markdown: string, prompt: string) => Promise<void>;
  items: RecentActivityItem[];
  /** Runs whose background summary job is in flight; each card holds a
   * spinner in its summary slot until the summary arrives. */
  recapPendingNodeIds?: ReadonlySet<string>;
  researchTrees: ResearchTreeSummary[];
  nextCursor: RecentActivityCursor | null;
  loadingOlder: boolean;
  olderError: string | null;
  /** The most recently removed entry, still restorable. */
  pendingUndo: { entry: JournalEntry } | null;
  /** Classifies a pasted URL or typed note into a saved feed entry. Reached
   * from the feed's own actions menu now that the composer slot holds the
   * research query composer. */
  onAddEntry: (input: string) => void;
  onRemoveEntry: (id: string) => void;
  onRetryTweet: (id: string) => void;
  onUndoRemove: () => void;
  onDismissUndo: () => void;
  onOpenResearchQuery: (query: RecentResearchQuery) => void;
  /** Receives a node whose summary was regenerated from a card's menu. */
  onResearchRecapApplied?: (node: ResearchNode) => void;
  /** Surfaces a failure the feed cannot show in place, such as a summary
   * regeneration that could not load its answer. */
  onError?: (message: string) => void;
  /** Home's per-thread Follow and Bookmark controls; both persist on the tree. */
  onSetResearchFollowed?: (treeId: string, followed: boolean) => void;
  onSetResearchBookmarked?: (treeId: string, bookmarked: boolean) => void;
  /** The per-thread menu. Present together: without them a card's context
   * menu has nothing to offer and is not opened. */
  folderState?: ResearchFolderState;
  onRenameResearch?: (treeId: string, title: string) => Promise<void>;
  onArchiveResearch?: (treeId: string) => Promise<void>;
  onRestoreResearch?: (treeId: string) => Promise<void>;
  onRemoveResearch?: (treeId: string) => Promise<void>;
  onToggleResearchStar?: (id: string) => void;
  onRequestCreateFolder?: (treeIds: string[]) => void;
  onRemoveFromFolder?: (treeIds: string[]) => void;
  onLoadOlder: () => void;
  /** Refetches the feed's first page from the header's Refresh control. */
  onRefresh?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
}

const JOURNAL_MENU_WIDTH = 180;
const JOURNAL_MENU_HEIGHT_ESTIMATE = 132;
const JOURNAL_VIEWPORT_MARGIN = 8;

export type JournalMenuAction = "open" | "copy" | "retry" | "delete";

export interface JournalMenuItem {
  action: JournalMenuAction;
  label: string;
  /** Single-letter keycap shown in the menu; pressing it fires the item. */
  key: string;
  danger?: boolean;
}

/** The URL an entry stands for, if any: the canonical tweet permalink once
 * hydrated, otherwise what the user entered. Notes have none. */
export function journalEntryUrl(entry: JournalEntry): string | null {
  if (entry.kind === "link") {
    return entry.url;
  }
  if (entry.kind === "tweet") {
    return entry.tweet?.url ?? entry.url;
  }
  return null;
}

/** Context-menu items for an entry. Pure, so tests can pin the layout and
 * keycaps per entry kind without driving the portal menu. */
export function journalEntryMenuItems(entry: JournalEntry): JournalMenuItem[] {
  const items: JournalMenuItem[] = [];
  if (journalEntryUrl(entry)) {
    items.push({
      action: "open",
      label: entry.kind === "tweet" ? "Open on X" : "Open link",
      key: "O",
    });
  }
  items.push({
    action: "copy",
    label: entry.kind === "note" ? "Copy text" : "Copy link",
    key: "C",
  });
  if (entry.kind === "tweet" && entry.hydration !== "pending") {
    items.push({
      action: "retry",
      label: entry.hydration === "failed" ? "Retry tweet" : "Refresh tweet",
      key: "R",
    });
  }
  items.push({ action: "delete", label: "Delete", key: "D", danger: true });
  return items;
}

const JOURNAL_FEED_MENU_WIDTH = 200;

/** Label of the feed menu's creation item. Exported so the affordance that
 * keeps note, link and post creation reachable can be asserted directly. */
export const JOURNAL_CREATE_ENTRY_LABEL = "Add link or note…";

/** Hands a non-blank draft to the feed's entry classifier. Returns false for a
 * blank draft, so an empty submit is a no-op rather than an empty note. */
export function submitJournalEntryDraft(
  draft: string,
  onAddEntry: (input: string) => void,
): boolean {
  const text = draft.trim();
  if (!text) {
    return false;
  }
  onAddEntry(text);
  return true;
}

/** The feed-level actions. The query composer owns the top of the page, so
 * saving a link, a note or an X post happens from here. */
export function JournalFeedMenuItems({ onCreateEntry }: { onCreateEntry: () => void }) {
  return (
    <div className="group-context-actions">
      <MenuItem onClick={onCreateEntry}>
        <Plus size={13} aria-hidden="true" />
        <span>{JOURNAL_CREATE_ENTRY_LABEL}</span>
      </MenuItem>
    </div>
  );
}

/** One field for a URL or a note; the backend classifier decides which it is. */
function JournalEntryCreateDialog({
  onAddEntry,
  onClose,
}: {
  onAddEntry: (input: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <DialogRoot onDismiss={onClose}>
      <DialogForm
        className="rename-dialog"
        aria-labelledby="journal-create-entry-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (submitJournalEntryDraft(draft, onAddEntry)) {
            onClose();
          }
        }}
      >
        <DialogTitle id="journal-create-entry-title">Add link or note</DialogTitle>
        <Input
          ref={inputRef}
          className="rename-dialog-input"
          value={draft}
          aria-label="Link or note"
          placeholder="Paste a URL or type a note…"
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <DialogActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!draft.trim()}>
            Add
          </Button>
        </DialogActions>
      </DialogForm>
    </DialogRoot>
  );
}

function JournalFeedMenu({ onAddEntry }: { onAddEntry: (input: string) => void }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeMenu = useCallback(() => setOpen(false), []);
  const menuStyle = useAnchoredPopover({
    open,
    onClose: closeMenu,
    triggerRef,
    popoverRef: menuRef,
    preferredWidth: JOURNAL_FEED_MENU_WIDTH,
    align: "end",
  });
  return (
    <>
      <Button
        ref={triggerRef}
        variant="icon"
        className="journal-feed-menu-trigger"
        title="Feed actions"
        aria-label="Feed actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus size={15} aria-hidden="true" />
      </Button>
      {open ? (
        <PopoverPortal>
          <Menu
            ref={menuRef}
            className="pane-context-menu journal-feed-menu"
            aria-label="Feed actions"
            style={menuStyle ?? { left: -9999, top: -9999 }}
          >
            <JournalFeedMenuItems
              onCreateEntry={() => {
                setOpen(false);
                setCreating(true);
              }}
            />
          </Menu>
        </PopoverPortal>
      ) : null}
      {creating ? (
        <JournalEntryCreateDialog
          onAddEntry={onAddEntry}
          onClose={() => {
            setCreating(false);
            triggerRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

function externalLinkClick(url: string) {
  return (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void openExternalUrl(url);
  };
}

/** The hydrated tweet, rendered as the entry's whole content — an X-embed
 * look with no wrapper chrome of its own, so the feed reads as tweets rather
 * than tweets inside content items. Exported for the static-markup tests. */
export function JournalTweetCard({ entry }: { entry: JournalTweetEntry }) {
  return entry.tweet ? <TweetEmbed tweet={entry.tweet} /> : null;
}

function menuItemIcon(action: JournalMenuAction) {
  switch (action) {
    case "open":
      return <ExternalLink size={13} aria-hidden="true" />;
    case "copy":
      return <Copy size={13} aria-hidden="true" />;
    case "retry":
      return <RotateCw size={13} aria-hidden="true" />;
    case "delete":
      return <Trash2 size={13} aria-hidden="true" />;
  }
}

function JournalEntryCard({
  entry,
  menuOpen,
  onOpenMenu,
  onOpenContextMenu,
  onRetryTweet,
}: {
  entry: JournalEntry;
  menuOpen: boolean;
  onOpenMenu: (entryId: string, trigger: HTMLButtonElement) => void;
  onOpenContextMenu: (entryId: string, clientX: number, clientY: number) => void;
  onRetryTweet: (id: string) => void;
}) {
  let body;
  let variant;
  if (entry.kind === "note") {
    variant = "is-note";
    body = <p className="journal-note-text">{entry.text}</p>;
  } else if (entry.kind === "link") {
    variant = "is-link";
    body = (
      <a
        className="journal-link-url"
        href={entry.url}
        onClick={externalLinkClick(entry.url)}
      >
        {entry.url}
      </a>
    );
  } else if (entry.hydration === "ok" && entry.tweet) {
    variant = "is-tweet";
    body = <JournalTweetCard entry={entry} />;
  } else if (entry.hydration === "failed") {
    variant = "is-tweet-failed";
    body = (
      <div className="journal-tweet-placeholder">
        <a
          className="journal-link-url"
          href={entry.url}
          onClick={externalLinkClick(entry.url)}
        >
          {entry.url}
        </a>
        <p className="journal-tweet-error">
          Couldn’t load this tweet{entry.error ? ` — ${entry.error}` : ""}.
        </p>
        <Button className="journal-tweet-retry" onClick={() => onRetryTweet(entry.id)}>
          <RotateCw size={12} aria-hidden="true" />
          <span>Retry</span>
        </Button>
      </div>
    );
  } else {
    variant = "is-tweet-pending";
    body = (
      <div className="journal-tweet-placeholder">
        <a
          className="journal-link-url"
          href={entry.url}
          onClick={externalLinkClick(entry.url)}
        >
          {entry.url}
        </a>
        <p className="journal-tweet-loading">
          <LoaderCircle size={12} aria-hidden="true" />
          <span>Loading tweet…</span>
        </p>
      </div>
    );
  }
  return (
    <article
      className={`journal-entry research-content-card ${variant}${
        menuOpen ? " has-open-menu" : ""
      }`}
      title={new Date(entry.createdAt).toLocaleString()}
      onContextMenu={(event) => {
        // Right-clicking a link or the quote card keeps the entry menu too —
        // the browser menu has nothing useful to offer inside the shell.
        event.preventDefault();
        event.stopPropagation();
        onOpenContextMenu(entry.id, event.clientX, event.clientY);
      }}
    >
      {body}
      <Button
        className="journal-entry-menu-trigger"
        title="Entry actions"
        aria-label="Entry actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-journal-menu-trigger
        onClick={(event) => onOpenMenu(entry.id, event.currentTarget)}
      >
        <MoreHorizontal size={13} aria-hidden="true" />
      </Button>
    </article>
  );
}

/** A click that landed on a link or a button inside rendered Markdown belongs
 * to that control, not to the card's open-the-thread target. */
function isMarkdownInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("a, button"));
}

/** The passage a targeted follow-up was asked about, shortened to a prefix
 * that still reads as a phrase. */
export function recentQueryTargetExcerpt(target: string, maxWords = 5, maxChars = 40) {
  const normalized = target.split(/\s+/).filter(Boolean).join(" ");
  const words = normalized.split(" ").filter(Boolean);
  if (words.length === 0) return "";
  const wordExcerpt = words.slice(0, maxWords).join(" ");
  const truncated = words.length > maxWords || Array.from(normalized).length > maxChars;
  if (!truncated) return wordExcerpt;

  const characterLimit = Math.max(1, maxChars - 1);
  let excerpt = Array.from(wordExcerpt).slice(0, characterLimit).join("").trimEnd();
  if (Array.from(wordExcerpt).length > characterLimit) {
    excerpt = excerpt.replace(/\s+\S*$/u, "").trimEnd() || excerpt;
  }
  return `${excerpt}…`;
}

/** One top-level research question in the feed: the authored prompt rendered
 * the same way an open thread renders it, its summary, its direct follow-ups,
 * and a footer carrying the thread actions beside the event metadata. */
export function ResearchQueryCard({
  query,
  metadata,
  recapPending = false,
  followed = false,
  bookmarked = false,
  onToggleFollow,
  onToggleBookmark,
  onOpen,
  onContextMenu,
  onOpenChild,
}: {
  query: RecentResearchQuery;
  /** Event metadata (context phrase and relative time), shown on the card's
   * footer row beside the thread actions. */
  metadata?: ReactNode;
  /** A background summary job is in flight for this run. */
  recapPending?: boolean;
  followed?: boolean;
  bookmarked?: boolean;
  onToggleFollow?: () => void;
  onToggleBookmark?: () => void;
  onOpen: () => void;
  onContextMenu: (clientX: number, clientY: number) => void;
  onOpenChild?: (query: RecentResearchQuery) => void;
}) {
  const recap = query.recap?.trim() ?? "";
  const running = isActiveResearchStatus(query.status);
  // A running question shows its spinner and nothing else below the prompt;
  // the thread actions and metadata row appear once the answer settles.
  const actions =
    !running && onToggleFollow && onToggleBookmark ? (
      <ResearchThreadActions
        followed={followed}
        bookmarked={bookmarked}
        onToggleFollow={onToggleFollow}
        onToggleBookmark={onToggleBookmark}
      />
    ) : null;
  return (
    <div
      className="recent-query-block"
      onContextMenu={(event) => {
        if (event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event.clientX, event.clientY);
      }}
    >
      <ResearchUserMessage as="article" className="recent-query-card research-prompt">
        <ResearchMessageBody
          prompt={query.prompt}
          attachments={query.attachments}
          renderPrompt={(content) => (
            <div
              className="recent-query-question-link"
              role="button"
              tabIndex={0}
              onClick={(event) => {
                if (!isMarkdownInteractiveTarget(event.target)) onOpen();
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onOpen();
              }}
            >
              {content}
            </div>
          )}
        />
      </ResearchUserMessage>
      {running ? (
        <span
          className="recent-query-spinner"
          role="status"
          aria-label="Generating answer"
          title="Generating answer"
        >
          <LoaderCircle size={14} aria-hidden="true" />
        </span>
      ) : null}
      {recap ? (
        <ResearchRecapLine text={recap} className="recent-query-recap" />
      ) : recapPending && !running ? (
        <ResearchRecapPendingLine className="recent-query-recap" />
      ) : null}
      {query.children?.length && onOpenChild ? (
        <ul
          className="recent-query-children"
          aria-label="Follow-up questions"
          onClick={(event) => event.stopPropagation()}
        >
          {query.children.map((child) => {
            const targetExcerpt = recentQueryTargetExcerpt(child.queryTarget ?? "");
            return (
              <li key={child.nodeId} className="recent-query-child">
                {targetExcerpt ? (
                  <>
                    <span
                      className="recent-query-child-target"
                      title={child.queryTarget ?? undefined}
                    >
                      @{targetExcerpt}
                    </span>{" "}
                  </>
                ) : null}
                <span
                  className="recent-query-child-link"
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenChild(child);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenChild(child);
                  }}
                >
                  <span className="recent-query-child-question">{child.prompt}</span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {!running && (actions || metadata) ? (
        <div className="recent-query-footer">
          {actions}
          {metadata ? <div className="recent-query-metadata">{metadata}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

type VirtualActivityRow = {
  kind: "event";
  key: string;
  event: RecentActivityEvent;
  position: number;
};

/** The feed is one uninterrupted column: every row is an event, and each one
 * carries the relative time in its own metadata line. */
export function buildRecentActivityVirtualRows(
  feed: RecentActivityEvent[],
): VirtualActivityRow[] {
  return feed.map((event, index) => ({
    kind: "event",
    key: event.id,
    event,
    position: index + 1,
  }));
}

/** First-paint guesses only; every mounted row is measured. Calibrated for the
 * feed column at --research-feed-max-width, so they move with that width. */
function estimatedActivityRowHeight(row: VirtualActivityRow): number {
  if (row.event.source.kind === "research-query") {
    if (
      row.event.source.query.attachments?.some(
        (attachment) => attachment.status === "resolved" && attachment.tweet,
      )
    ) {
      return row.event.source.query.recap?.trim() ? 430 : 384;
    }
    return row.event.source.query.recap?.trim() ? 136 : 90;
  }
  const entry = row.event.source.entry;
  if (entry.kind === "tweet" && entry.hydration === "ok") return 326;
  return 104;
}

export interface VirtualActivityRange {
  start: number;
  end: number;
}

/** Binary-searches cumulative row geometry, keeping scroll work logarithmic
 * even when the feed contains many thousands of loaded records. */
export function virtualActivityRange(
  offsets: number[],
  sizes: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan = 700,
): VirtualActivityRange {
  if (offsets.length === 0) return { start: 0, end: 0 };
  const minimum = Math.max(0, scrollTop - overscan);
  const maximum = scrollTop + viewportHeight + overscan;
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle] + sizes[middle] < minimum) low = middle + 1;
    else high = middle;
  }
  const start = low;
  low = start;
  high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle] <= maximum) low = middle + 1;
    else high = middle;
  }
  return { start, end: low };
}

function MeasuredActivityRow({
  rowKey,
  top,
  onMeasure,
  onFocusCapture,
  onBlurCapture,
  children,
}: {
  rowKey: string;
  top: number;
  onMeasure: (key: string, height: number) => void;
  onFocusCapture?: () => void;
  onBlurCapture?: (event: FocusEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => onMeasure(rowKey, element.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onMeasure, rowKey]);
  return (
    <div
      ref={ref}
      className="recent-activity-virtual-row"
      style={{ transform: `translateY(${top}px)` }}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      {children}
    </div>
  );
}

function ResearchActivityFeed({
  composer,
  initialScrollAnchor = null,
  onScrollAnchorChange,
  view = "home",
  setupGuide,
  items,
  recapPendingNodeIds = EMPTY_RECAP_PENDING_NODE_IDS,
  researchTrees,
  nextCursor,
  loadingOlder,
  olderError,
  pendingUndo,
  onAddEntry,
  onRemoveEntry,
  onRetryTweet,
  onUndoRemove,
  onDismissUndo,
  onOpenResearchQuery,
  onResearchRecapApplied,
  onError,
  onSetResearchFollowed,
  onSetResearchBookmarked,
  folderState,
  onRenameResearch,
  onArchiveResearch,
  onRestoreResearch,
  onRemoveResearch,
  onToggleResearchStar,
  onRequestCreateFolder,
  onRemoveFromFolder,
  onLoadOlder,
  onRefresh,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
}: ResearchActivityFeedProps) {
  const [menu, setMenu] = useState<
    | { kind: "journal"; entryId: string; left: number; top: number }
    | {
        kind: "tree";
        treeId: string;
        /** The card the menu was opened from, for its query-specific items. */
        queryNodeId?: string;
        archived: boolean;
        left: number;
        top: number;
      }
    | null
  >(null);
  const [renamingTree, setRenamingTree] = useState<ResearchTreeSummary | null>(null);
  const [deletingTree, setDeletingTree] = useState<ResearchTreeSummary | null>(null);
  const [recapDialogContent, setRecapDialogContent] = useState<ResearchNodeContent | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const initialScrollAnchorRef = useRef(initialScrollAnchor);
  const onScrollAnchorChangeRef = useRef(onScrollAnchorChange);
  onScrollAnchorChangeRef.current = onScrollAnchorChange;
  const virtualCanvasRef = useRef<HTMLDivElement | null>(null);
  const loadSentinelRef = useRef<HTMLDivElement | null>(null);
  const onBackRef = useRef(onBack);
  const onForwardRef = useRef(onForward);
  onBackRef.current = onBack;
  onForwardRef.current = onForward;
  useResearchSwipeNavigation(scrollRef, onBack, onForward);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }
      const primary = event.metaKey || event.ctrlKey;
      let handler: (() => void) | undefined;
      if (primary && !event.altKey && !event.shiftKey && event.code === "BracketLeft") {
        handler = onBackRef.current;
      } else if (primary && !event.altKey && !event.shiftKey && event.code === "BracketRight") {
        handler = onForwardRef.current;
      } else if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.key === "ArrowLeft"
      ) {
        handler = onBackRef.current;
      } else if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.key === "ArrowRight"
      ) {
        handler = onForwardRef.current;
      }
      if (handler) {
        event.preventDefault();
        handler();
      }
    };
    const onMouseUp = (event: globalThis.MouseEvent) => {
      if (event.button === 3) {
        event.preventDefault();
        onBackRef.current?.();
      } else if (event.button === 4) {
        event.preventDefault();
        onForwardRef.current?.();
      }
    };
    const mouseTarget = scrollRef.current;
    window.addEventListener("keydown", onKeyDown);
    mouseTarget?.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      mouseTarget?.removeEventListener("mouseup", onMouseUp);
    };
  }, []);
  const visibleItems = useMemo(() => {
    if (view !== "bookmarks") return items;
    const bookmarked = new Set(
      researchTrees.filter((tree) => tree.bookmarked).map((tree) => tree.id),
    );
    return items.filter(
      (item) => item.kind === "research-query" && bookmarked.has(item.query.treeId),
    );
  }, [items, researchTrees, view]);
  const feed = useMemo(
    () => buildRecentActivityFromItems(visibleItems, researchTrees),
    [researchTrees, visibleItems],
  );
  const viewTitle = view === "bookmarks" ? "Bookmarks" : "Home";
  const treeById = useMemo(() => {
    const map = new Map<string, ResearchTreeSummary>();
    for (const tree of researchTrees) {
      map.set(tree.id, tree);
    }
    return map;
  }, [researchTrees]);
  const [dayBoundaryVersion, setDayBoundaryVersion] = useState(0);
  useEffect(() => {
    const nextMidnight = new Date();
    nextMidnight.setHours(24, 0, 0, 25);
    const timer = window.setTimeout(
      () => setDayBoundaryVersion((version) => version + 1),
      nextMidnight.getTime() - Date.now(),
    );
    return () => window.clearTimeout(timer);
  }, [dayBoundaryVersion]);
  const rows = useMemo(
    () => buildRecentActivityVirtualRows(feed),
    [dayBoundaryVersion, feed],
  );
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const measuredHeightsRef = useRef(new Map<string, number>());
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const measurementFrameRef = useRef(0);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 800 });
  const metrics = useMemo(() => {
    const offsets: number[] = [];
    const sizes: number[] = [];
    const indexByKey = new Map<string, number>();
    let totalSize = 0;
    for (const [index, row] of rows.entries()) {
      indexByKey.set(row.key, index);
      offsets.push(totalSize);
      const size = measuredHeightsRef.current.get(row.key) ?? estimatedActivityRowHeight(row);
      sizes.push(size);
      totalSize += size;
    }
    return { offsets, sizes, totalSize, indexByKey };
  }, [measurementVersion, rows]);
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;
  const range = virtualActivityRange(
    metrics.offsets,
    metrics.sizes,
    viewport.scrollTop,
    viewport.height,
  );
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const visibleRowEntries = useMemo(() => {
    const entries = rows
      .slice(range.start, range.end)
      .map((row, localIndex) => ({ row, index: range.start + localIndex }));
    const focusedIndex = focusedRowKey ? metrics.indexByKey.get(focusedRowKey) : undefined;
    if (
      focusedIndex !== undefined &&
      (focusedIndex < range.start || focusedIndex >= range.end)
    ) {
      entries.push({ row: rows[focusedIndex], index: focusedIndex });
      entries.sort((left, right) => left.index - right.index);
    }
    return entries;
  }, [focusedRowKey, metrics.indexByKey, range.end, range.start, rows]);
  const [newActivityCount, setNewActivityCount] = useState(0);
  const anchorRef = useRef<RecentActivityScrollAnchor | null>(null);
  const knownItemIdsRef = useRef(new Set(items.map(recentActivityItemId)));
  const previousTopItemIdRef = useRef(items[0] ? recentActivityItemId(items[0]) : null);

  const captureScrollState = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const geometry = metricsRef.current;
    const currentRows = rowsRef.current;
    const canvasTop = virtualCanvasRef.current?.offsetTop ?? 0;
    const feedScrollTop = Math.max(0, scroller.scrollTop - canvasTop);
    const visible = virtualActivityRange(
      geometry.offsets,
      geometry.sizes,
      feedScrollTop,
      scroller.clientHeight,
      0,
    ).start;
    const row = currentRows[visible];
    anchorRef.current = row
      ? {
          key: row.key,
          offset: recentActivityAnchorOffset(
            canvasTop,
            geometry.offsets[visible],
            scroller.scrollTop,
          ),
        }
      : null;
    setViewport({ scrollTop: feedScrollTop, height: scroller.clientHeight });
    onScrollAnchorChangeRef.current?.(anchorRef.current);
    if (scroller.scrollTop <= 60) setNewActivityCount(0);
  }, []);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(captureScrollState);
    };
    captureScrollState();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(scroller);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      observer?.disconnect();
    };
  }, [captureScrollState]);

  // Keep the first visible row at the same pixel when a live item is inserted
  // above it or a measured tweet replaces its estimate.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const anchor = anchorRef.current;
    const canvasTop = virtualCanvasRef.current?.offsetTop ?? 0;
    if (!scroller || !anchor || scroller.scrollTop <= Math.max(60, canvasTop)) return;
    const index = metrics.indexByKey.get(anchor.key);
    if (index === undefined) return;
    const desired = recentActivityAnchorScrollTop(
      canvasTop,
      metrics.offsets[index],
      anchor.offset,
    );
    if (Math.abs(scroller.scrollTop - desired) > 0.5) {
      scroller.scrollTop = desired;
      setViewport({
        scrollTop: Math.max(0, desired - canvasTop),
        height: scroller.clientHeight,
      });
    }
    captureScrollState();
  }, [captureScrollState, metrics, rows]);

  // Restore the anchor App held while the feed was unmounted. Runs once, from
  // the ref, so a later save cannot re-scroll the reader.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const anchor = initialScrollAnchorRef.current;
    const index = anchor ? metricsRef.current.indexByKey.get(anchor.key) : undefined;
    if (scroller && anchor && index !== undefined) {
      anchorRef.current = anchor;
      scroller.scrollTop = recentActivityAnchorScrollTop(
        virtualCanvasRef.current?.offsetTop ?? 0,
        metricsRef.current.offsets[index],
        anchor.offset,
      );
    }
  }, []);

  useEffect(() => {
    const previousTopId = previousTopItemIdRef.current;
    const previousTopIndex = previousTopId
      ? items.findIndex((item) => recentActivityItemId(item) === previousTopId)
      : -1;
    const candidates = previousTopIndex >= 0 ? items.slice(0, previousTopIndex) : [];
    const addedAbove = candidates.filter(
      (item) => !knownItemIdsRef.current.has(recentActivityItemId(item)),
    ).length;
    if (addedAbove > 0 && (scrollRef.current?.scrollTop ?? 0) > 60) {
      setNewActivityCount((count) => count + addedAbove);
    }
    knownItemIdsRef.current = new Set(items.map(recentActivityItemId));
    previousTopItemIdRef.current = items[0] ? recentActivityItemId(items[0]) : null;
  }, [items]);

  const measureRow = useCallback((key: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) return;
    const previous = measuredHeightsRef.current.get(key);
    if (previous !== undefined && Math.abs(previous - height) < 0.5) return;
    measuredHeightsRef.current.set(key, height);
    if (measurementFrameRef.current === 0) {
      measurementFrameRef.current = requestAnimationFrame(() => {
        measurementFrameRef.current = 0;
        setMeasurementVersion((version) => version + 1);
      });
    }
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(measurementFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    const liveKeys = new Set(rows.map((row) => row.key));
    for (const key of measuredHeightsRef.current.keys()) {
      if (!liveKeys.has(key)) measuredHeightsRef.current.delete(key);
    }
  }, [rows]);

  useEffect(() => {
    const sentinel = loadSentinelRef.current;
    const scroller = scrollRef.current;
    if (
      !sentinel ||
      !scroller ||
      !nextCursor ||
      loadingOlder ||
      olderError ||
      typeof IntersectionObserver === "undefined"
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadOlder();
      },
      { root: scroller, rootMargin: "700px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadingOlder, nextCursor, olderError, onLoadOlder]);

  const menuActivityItem =
    menu?.kind === "journal"
      ? items.find((item) => item.kind === "journal" && item.entry.id === menu.entryId)
      : null;
  const menuEntry = menuActivityItem?.kind === "journal" ? menuActivityItem.entry : null;
  const menuItems = menuEntry ? journalEntryMenuItems(menuEntry) : [];
  const menuTree = menu?.kind === "tree" ? (treeById.get(menu.treeId) ?? null) : null;
  const menuQueryItem =
    menu?.kind === "tree" && menu.queryNodeId
      ? (items.find(
          (item) => item.kind === "research-query" && item.query.nodeId === menu.queryNodeId,
        ) ?? null)
      : null;
  const menuQuery = menuQueryItem?.kind === "research-query" ? menuQueryItem.query : null;
  // The per-thread menu is only offered when the actions behind it exist.
  const threadMenuAvailable = Boolean(
    folderState &&
      onToggleResearchStar &&
      onRenameResearch &&
      onArchiveResearch &&
      onRestoreResearch &&
      onRemoveResearch &&
      onRequestCreateFolder &&
      onRemoveFromFolder,
  );

  function runMenuAction(entry: JournalEntry, action: JournalMenuAction) {
    setMenu(null);
    if (action === "open") {
      const url = journalEntryUrl(entry);
      if (url) {
        void openExternalUrl(url);
      }
      return;
    }
    if (action === "copy") {
      void writeClipboardText(
        entry.kind === "note" ? entry.text : journalEntryUrl(entry) ?? "",
      );
      return;
    }
    if (action === "retry") {
      onRetryTweet(entry.id);
      return;
    }
    onRemoveEntry(entry.id);
  }

  function clampedMenuPosition(
    clientX: number,
    clientY: number,
    width = JOURNAL_MENU_WIDTH,
  ) {
    return {
      left: Math.max(
        JOURNAL_VIEWPORT_MARGIN,
        Math.min(clientX, window.innerWidth - width - JOURNAL_VIEWPORT_MARGIN),
      ),
      top: Math.max(
        JOURNAL_VIEWPORT_MARGIN,
        Math.min(
          clientY,
          window.innerHeight - JOURNAL_MENU_HEIGHT_ESTIMATE - JOURNAL_VIEWPORT_MARGIN,
        ),
      ),
    };
  }

  function openMenuFromTrigger(entryId: string, trigger: HTMLButtonElement) {
    if (menu?.kind === "journal" && menu.entryId === entryId) {
      setMenu(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    setMenu({
      kind: "journal",
      entryId,
      ...clampedMenuPosition(rect.right - JOURNAL_MENU_WIDTH, rect.bottom + 4),
    });
  }

  function openContextMenu(entryId: string, clientX: number, clientY: number) {
    setMenu({ kind: "journal", entryId, ...clampedMenuPosition(clientX, clientY) });
  }

  function openTreeContextMenu(
    tree: ResearchTreeSummary,
    clientX: number,
    clientY: number,
    queryNodeId?: string,
  ) {
    setMenu({
      kind: "tree",
      treeId: tree.id,
      queryNodeId,
      archived: Boolean(tree.archivedAt),
      ...clampedMenuPosition(clientX, clientY, RESEARCH_TREE_MENU_WIDTH),
    });
  }

  // The card carries only the summary text, so the dialog's baseline answer
  // revision and recap identity are fetched before it opens.
  function openRecapDialog(nodeId: string) {
    void getResearchNodeContent(nodeId)
      .then((content) => setRecapDialogContent(content))
      .catch((err: unknown) => onError?.(err instanceof Error ? err.message : String(err)));
  }

  // Menu dismissal and its keycap shortcuts, mirroring the research sidebar
  // menus: outside mousedown, Escape, viewport reflow all close; a bare
  // keycap letter fires its item.
  useEffect(() => {
    if (!menu) {
      return;
    }
    const closeMenu = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !(target instanceof Element && target.closest("[data-journal-menu-trigger]"))
      ) {
        setMenu(null);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(null);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (menu.kind === "journal") {
        const activityItem = items.find(
          (candidate) =>
            candidate.kind === "journal" && candidate.entry.id === menu.entryId,
        );
        const entry = activityItem?.kind === "journal" ? activityItem.entry : null;
        if (!entry) {
          return;
        }
        const item = journalEntryMenuItems(entry).find(
          (candidate) => candidate.key.toLowerCase() === event.key.toLowerCase(),
        );
        if (!item) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        runMenuAction(entry, item.action);
        return;
      }
      const tree = treeById.get(menu.treeId);
      if (!tree) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key !== "d" && (key !== "a" || menu.archived)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (tree.runningCount > 0) {
        return;
      }
      if (key === "d") {
        setMenu(null);
        setDeletingTree(tree);
        return;
      }
      setMenu(null);
      void onArchiveResearch?.(tree.id);
    };
    const closeOnReflow = () => setMenu(null);
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeOnReflow);
    window.addEventListener("scroll", closeOnReflow, true);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeOnReflow);
      window.removeEventListener("scroll", closeOnReflow, true);
    };
    // runMenuAction and items are stable enough per menu lifetime; the menu
    // closes on any entry mutation the actions cause.
  });

  // The height estimate that positioned the menu is a guess (items vary per
  // entry kind); clamp the real menu back inside the viewport once rendered.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) {
      return;
    }
    const height = element.getBoundingClientRect().height;
    const top = Math.max(
      JOURNAL_VIEWPORT_MARGIN,
      Math.min(menu.top, window.innerHeight - JOURNAL_VIEWPORT_MARGIN - height),
    );
    if (top !== menu.top) {
      element.style.top = `${top}px`;
    }
  }, [menu]);

  // ⌘Z / Ctrl-Z restores the last removed entry while the undo bar shows.
  useEffect(() => {
    if (!pendingUndo) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        onUndoRemove();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onUndoRemove, pendingUndo]);

  return (
    <ResearchDocumentFrame
      title={viewTitle}
      headerActions={
        view === "home" ? <JournalFeedMenu onAddEntry={onAddEntry} /> : undefined
      }
      navActions={
        onRefresh ? (
          <Button
            variant="icon"
            className="research-history-button"
            aria-label={`Refresh ${viewTitle}`}
            title={`Refresh ${viewTitle}`}
            onClick={onRefresh}
          >
            <RotateCw size={16} aria-hidden="true" />
          </Button>
        ) : undefined
      }
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      backTitle={`Back (${IS_MAC ? "⌘[" : "Ctrl+["})`}
      forwardTitle={`Forward (${IS_MAC ? "⌘]" : "Ctrl+]"})`}
      onBack={onBack}
      onForward={onForward}
    >
      <div ref={scrollRef} className="research-document-scroll journal-scroll">
        <div className="journal-column research-reading-surface">
          {view === "home" && composer ? (
            <div className="journal-composer-container">{composer}</div>
          ) : null}
          {pendingUndo ? (
            <div className="journal-undo" role="status">
              <span className="journal-undo-label">
                {pendingUndo.entry.kind === "note" ? "Note" : "Entry"} removed
              </span>
              <Button className="journal-undo-restore" onClick={onUndoRemove}>
                <Undo2 size={12} aria-hidden="true" />
                <span>Undo</span>
                <kbd className="context-menu-shortcut is-keycap">⌘Z</kbd>
              </Button>
              <Button
                className="journal-undo-dismiss"
                title="Dismiss"
                aria-label="Dismiss undo"
                onClick={onDismissUndo}
              >
                <X size={12} aria-hidden="true" />
              </Button>
            </div>
          ) : null}
          {newActivityCount > 0 ? (
            <div className="recent-activity-new-status" role="status" aria-live="polite">
              <Button
                className="recent-activity-new"
                onClick={() => {
                  setNewActivityCount(0);
                  const reduceMotion = window.matchMedia?.(
                    "(prefers-reduced-motion: reduce)",
                  ).matches;
                  scrollRef.current?.scrollTo({
                    top: 0,
                    behavior: reduceMotion ? "auto" : "smooth",
                  });
                }}
              >
                {newActivityCount} new {newActivityCount === 1 ? "activity" : "activities"}
              </Button>
            </div>
          ) : null}
          <div
            className="journal-feed"
            role="feed"
            aria-label="Recent activity"
            aria-busy={loadingOlder}
          >
            <div
              ref={virtualCanvasRef}
              className="recent-activity-virtual-canvas"
              style={{ height: metrics.totalSize }}
            >
              {visibleRowEntries.map(({ row, index }) => {
                const researchTreeId =
                  row.event.source.kind === "research-query"
                    ? row.event.source.query.treeId
                    : null;
                const researchTree = researchTreeId
                  ? treeById.get(researchTreeId)
                  : undefined;
                return (
                  <MeasuredActivityRow
                    key={row.key}
                    rowKey={row.key}
                    top={metrics.offsets[index]}
                    onMeasure={measureRow}
                    onFocusCapture={() => setFocusedRowKey(row.key)}
                    onBlurCapture={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setFocusedRowKey((current) => (current === row.key ? null : current));
                      }
                    }}
                  >
                    <div
                      className="recent-activity-unit"
                      role="article"
                      aria-posinset={row.position}
                      aria-setsize={nextCursor ? -1 : feed.length}
                    >
                      {row.event.source.kind === "journal" ? (
                        <>
                          <ActivityMetadataLine event={row.event} />
                          <JournalEntryCard
                            entry={row.event.source.entry}
                            menuOpen={
                              menu?.kind === "journal" &&
                              menu.entryId === row.event.source.entry.id
                            }
                            onOpenMenu={openMenuFromTrigger}
                            onOpenContextMenu={openContextMenu}
                            onRetryTweet={onRetryTweet}
                          />
                        </>
                      ) : (
                        <ResearchQueryCard
                          query={row.event.source.query}
                          metadata={<ActivityMetadataLine event={row.event} />}
                          recapPending={recapPendingNodeIds.has(
                            row.event.source.query.nodeId,
                          )}
                          followed={Boolean(researchTree?.followed)}
                          bookmarked={Boolean(researchTree?.bookmarked)}
                          onToggleFollow={
                            onSetResearchFollowed && researchTreeId
                              ? () =>
                                  onSetResearchFollowed(
                                    researchTreeId,
                                    !researchTree?.followed,
                                  )
                              : undefined
                          }
                          onToggleBookmark={
                            onSetResearchBookmarked && researchTreeId
                              ? () =>
                                  onSetResearchBookmarked(
                                    researchTreeId,
                                    !researchTree?.bookmarked,
                                  )
                              : undefined
                          }
                          onOpenChild={onOpenResearchQuery}
                          onOpen={() => {
                            const source = row.event.source;
                            if (source.kind === "research-query") {
                              onOpenResearchQuery(source.query);
                            }
                          }}
                          onContextMenu={(clientX, clientY) => {
                            const source = row.event.source;
                            if (source.kind !== "research-query" || !threadMenuAvailable) {
                              return;
                            }
                            const tree = treeById.get(source.query.treeId);
                            if (!tree) {
                              return;
                            }
                            openTreeContextMenu(tree, clientX, clientY, source.query.nodeId);
                          }}
                        />
                      )}
                    </div>
                  </MeasuredActivityRow>
                );
              })}
            </div>
            {feed.length === 0 ? (
              <div className="journal-empty-container">
                {view === "bookmarks" ? (
                  <p className="journal-empty">
                    Bookmarked research appears here, newest first.
                  </p>
                ) : setupGuide ? (
                  <div className="journal-setup-guide">{setupGuide}</div>
                ) : (
                  <p className="journal-empty">
                    Research queries and saved sources appear here, newest first.
                  </p>
                )}
              </div>
            ) : null}
            <div
              ref={loadSentinelRef}
              className="recent-activity-load-boundary"
              aria-live="polite"
              aria-atomic="true"
            >
              {nextCursor ? (
                <Button
                  className="recent-activity-load-older"
                  disabled={loadingOlder}
                  onClick={onLoadOlder}
                >
                  <ChevronDown size={13} aria-hidden="true" />
                  <span>
                    {loadingOlder
                      ? "Loading…"
                      : olderError
                        ? "Retry older activity"
                        : "Load older activity"}
                  </span>
                </Button>
              ) : null}
              {olderError ? (
                <p className="recent-activity-load-error" role="alert">
                  Couldn’t load older activity. {olderError}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {menu?.kind === "journal" && menuEntry
        ? createPortal(
            <Menu
              ref={menuRef}
              className="pane-context-menu journal-entry-menu"
              aria-label="Saved entry actions"
              style={{ left: menu.left, top: menu.top }}
              onMouseDown={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              <div className="group-context-actions">
                {menuItems.map((item, index) => (
                  <span key={item.action} style={{ display: "contents" }}>
                    {item.danger && index > 0 ? (
                      <div className="context-menu-divider" role="separator" />
                    ) : null}
                    <MenuItem
                      tone={item.danger ? "danger" : "neutral"}
                      className={`context-menu-has-shortcut${
                        item.danger ? " context-menu-danger" : ""
                      }`}
                      onClick={() => runMenuAction(menuEntry, item.action)}
                    >
                      {menuItemIcon(item.action)}
                      <span>{item.label}</span>
                      <kbd className="context-menu-shortcut is-keycap">{item.key}</kbd>
                    </MenuItem>
                  </span>
                ))}
              </div>
            </Menu>,
            document.body,
          )
        : null}
      {menu?.kind === "tree" && menuTree && folderState
        ? createPortal(
            <Menu
              ref={menuRef}
              className="pane-context-menu research-sidebar-menu"
              aria-label={`Actions for ${menuTree.title}`}
              style={{ left: menu.left, top: menu.top }}
              onMouseDown={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
            >
              <ResearchTreeMenuItems
                tree={menuTree}
                archived={menu.archived}
                folderState={folderState}
                onClose={() => setMenu(null)}
                onToggleStar={(treeId) => onToggleResearchStar?.(treeId)}
                onRename={(tree) => {
                  setMenu(null);
                  setRenamingTree(tree);
                }}
                onArchive={(treeId) => void onArchiveResearch?.(treeId)}
                onRestore={(treeId) => void onRestoreResearch?.(treeId)}
                onDelete={(tree) => {
                  setMenu(null);
                  setDeletingTree(tree);
                }}
                onRemoveFromFolder={(treeIds) => onRemoveFromFolder?.(treeIds)}
                onRequestCreateFolder={(treeIds) => onRequestCreateFolder?.(treeIds)}
                onRegenerateSummary={
                  onResearchRecapApplied &&
                  menuQuery &&
                  !menu.archived &&
                  menuQuery.status === "complete" &&
                  menuQuery.recap?.trim()
                    ? () => openRecapDialog(menuQuery.nodeId)
                    : undefined
                }
              />
            </Menu>,
            document.body,
          )
        : null}
      {renamingTree && onRenameResearch ? (
        <ResearchTreeRenameDialog
          tree={renamingTree}
          onClose={() => setRenamingTree(null)}
          onRename={onRenameResearch}
        />
      ) : null}
      {recapDialogContent ? (
        <ResearchRecapDialog
          content={recapDialogContent}
          onClose={() => setRecapDialogContent(null)}
          onApplied={(node) => {
            onResearchRecapApplied?.(node);
            setRecapDialogContent((current) =>
              current?.node.id === node.id ? { ...current, node } : current,
            );
          }}
        />
      ) : null}
      {deletingTree && onRemoveResearch ? (
        <ResearchTreeDeleteDialog
          tree={deletingTree}
          onClose={() => setDeletingTree(null)}
          onRemove={onRemoveResearch}
        />
      ) : null}
    </ResearchDocumentFrame>
  );
}

export default memo(ResearchActivityFeed);
