import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Copy, ExternalLink, LoaderCircle, MoreHorizontal, ScrollText, Trash2, X } from "lucide-react";
import { IS_MAC, isEditableTarget } from "../../lib/appHelpers";
import { CLAUDE_ADAPTER_ID } from "../../adapters/claude";
import { getResearchNodeContent, listClaudeSkills } from "../../lib/api";
import { writeClipboardText } from "../../lib/clipboard";
import { growComposerTextarea } from "../../lib/composerTextarea";
import {
  EMPTY_RESEARCH_HISTORY,
  canGoBack as historyCanGoBack,
  canGoForward as historyCanGoForward,
  initResearchHistory,
  pushResearchHistory,
  pruneResearchHistory,
  researchHistoryBack,
  researchHistoryForward,
  researchSwipeDirection,
} from "../../lib/researchHistory";
import { researchBranchInfo } from "../../lib/researchBranches";
import {
  isResearchNodeSelectionChange,
  pruneResearchNavigationNodes,
  researchNavigationStore,
  saveResearchNavigation,
} from "../../lib/researchNavigation";
import {
  assistantTextFromTimelineItems,
  buildTimelineItems,
  timelineItemsAfterLastToolCall,
  timelineItemsContainTranscriptActivity,
} from "../../lib/turnTimeline";
import type { MessageBlock, MessageItem } from "../../lib/turnTimeline";
import type {
  ResearchBranchRemoval,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeDetail,
} from "../../types";
import { ComposerSubmitShortcutGlyph } from "../ComposerSubmitShortcut";
import {
  RawTranscriptDisclosure,
  TranscriptActivityItem,
  timelineStatusClass,
} from "../TranscriptActivity";
import TranscriptMarkdown, {
  TranscriptLinkActionsProvider,
  type LinkActions,
} from "../TranscriptMarkdown";

interface ResearchDocumentProps {
  detail: ResearchTreeDetail | null;
  /** Durable sidebar title shown in the header while tree detail is loading. */
  treeTitle?: string;
  /** Archived trees remain browsable, but cannot be branched. */
  archived: boolean;
  /** Why `detail` is null, when the tree fetch itself failed. */
  detailError?: string | null;
  /** Refetches the active tree's detail after a failed load. */
  onRetryDetail?: () => void;
  onFork: (parentNodeId: string, prompt: string) => Promise<ResearchNode>;
  onRemoveBranch: (nodeId: string) => Promise<ResearchBranchRemoval>;
  onRemoveTree: (treeId: string) => Promise<void>;
  onCancel: (nodeId: string) => Promise<void>;
  onOpenPane: (paneId: string) => void;
  linkActions: LinkActions;
  onError: (message: string) => void;
  onToast: (message: string, tone?: "normal" | "warning") => void;
}

// The backend caps snapshots at 16MB, which is still far beyond what markdown
// parsing and eager React element creation can absorb without freezing the
// interface. Blocks past this size render as plain preformatted text — itself
// display-capped, since laying out one 16MB text node freezes the interface
// too — and long transcripts render only their tail until expanded.
const MARKDOWN_CHAR_LIMIT = 100_000;
const PLAINTEXT_DISPLAY_CHAR_LIMIT = 1_000_000;
const ACTIVITY_PAYLOAD_CHAR_LIMIT = 200_000;
const TIMELINE_ITEM_RENDER_WINDOW = 100;
// Hoisted so the memoized markdown renderer sees a stable prop identity — an
// inline object literal would defeat its render cache on every poll.
const OVERSIZED_MARKDOWN_POLICY = {
  maxCharacters: MARKDOWN_CHAR_LIMIT,
  maxDisplayCharacters: PLAINTEXT_DISPLAY_CHAR_LIMIT,
  fallbackClassName: "research-plaintext",
} as const;

const RESEARCH_SWIPE_IDLE_MS = 180;
const FOLLOWUP_MENU_WIDTH = 190;
const FOLLOWUP_MENU_HEIGHT = 38;
const FOLLOWUP_MENU_MARGIN = 8;

interface FollowupMenu {
  nodeId: string;
  left: number;
  top: number;
}

function horizontalScrollerConsumesWheel(
  target: EventTarget | null,
  boundary: HTMLElement,
  deltaX: number,
): boolean {
  let element = target instanceof Element ? target : null;
  while (element && element !== boundary && boundary.contains(element)) {
    if (element instanceof HTMLElement && element.scrollWidth > element.clientWidth) {
      const overflowX = getComputedStyle(element).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") {
        const canScrollLeft = deltaX < 0 && element.scrollLeft > 0;
        const canScrollRight =
          deltaX > 0 && element.scrollLeft < element.scrollWidth - element.clientWidth;
        if (canScrollLeft || canScrollRight) {
          return true;
        }
      }
    }
    element = element.parentElement;
  }
  return false;
}

function statusLabel(status: ResearchNode["status"]) {
  switch (status) {
    case "queued":
      return "Queued";
    case "starting":
      return "Starting";
    case "running":
      return "Researching…";
    case "complete":
      return "Complete";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${totalSeconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function countWords(text: string) {
  return text.match(/\S+/g)?.length ?? 0;
}

function unexpectedRoleLabel(role: string) {
  if (role === "system") {
    return "System content";
  }
  if (role === "user") {
    return "Additional user content";
  }
  return `${role || "Unknown"} content`;
}

function ResearchMessageBlock({ block, role }: { block: MessageBlock; role: string }) {
  if (block.type === "text") {
    if (role === "assistant") {
      return (
        <TranscriptMarkdown
          text={block.text}
          imageBehavior="open"
          oversizedContent={OVERSIZED_MARKDOWN_POLICY}
        />
      );
    }
    return <p className="research-unexpected-text">{block.text}</p>;
  }
  return (
    <RawTranscriptDisclosure
      value={block.value}
      maxPayloadCharacters={ACTIVITY_PAYLOAD_CHAR_LIMIT}
      deferPayload
    />
  );
}

// Memoized on item identity: the tree detail is replaced by every research
// event (4×/s while any run in the tree streams), and without the memo each
// replacement re-rendered — and re-parsed the markdown of — every visible
// item. Item identities are stable across detail replacements because they
// derive from `content`, which only changes when this node's own fetch lands.
const ResearchTimelineItem = memo(function ResearchTimelineItem({ item }: { item: MessageItem }) {
  const hasUnexpectedContent = item.role !== "assistant" && item.blocks.length > 0;
  return (
    <section
      className={`research-response-item role-${item.role}`}
      data-timeline-key={item.key}
    >
      {item.blocks.length > 0 ? (
        <div
          className={`research-response-message${
            hasUnexpectedContent ? " research-unexpected-content" : ""
          }${timelineStatusClass(item.status)}`}
        >
          {hasUnexpectedContent ? <span>{unexpectedRoleLabel(item.role)}</span> : null}
          {item.blocks.map((block, index) => (
            <ResearchMessageBlock key={`${item.key}-${index}`} block={block} role={item.role} />
          ))}
        </div>
      ) : null}
      {item.activities.map((activity) => (
        <TranscriptActivityItem
          key={activity.key}
          item={activity}
          isRootActivity
          maxPayloadCharacters={ACTIVITY_PAYLOAD_CHAR_LIMIT}
          deferPayloads
          showResultCharacterCount={false}
        />
      ))}
    </section>
  );
});

export default function ResearchDocument({
  detail,
  treeTitle,
  archived,
  detailError,
  onRetryDetail,
  onFork,
  onRemoveBranch,
  onRemoveTree,
  onCancel,
  onOpenPane,
  linkActions,
  onError,
  onToast,
}: ResearchDocumentProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Browser-style visit history for the header's back/forward controls, reset
  // per tree. Transitions live in ../../lib/researchHistory.
  const [history, setHistory] = useState(EMPTY_RESEARCH_HISTORY);
  const [content, setContent] = useState<ResearchNodeContent | null>(null);
  const [followup, setFollowup] = useState("");
  // "ask" sends the follow-up verbatim; "deep" invisibly prefixes the
  // deep-research slash command at submit time, mirroring the agent launcher's
  // skill mechanism. The composer text never shows the prefix.
  const [followupMode, setFollowupMode] = useState<"ask" | "deep">("ask");
  const [deepResearchSkillCommand, setDeepResearchSkillCommand] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [followupMenu, setFollowupMenu] = useState<FollowupMenu | null>(null);
  const [deletingBranchId, setDeletingBranchId] = useState<string | null>(null);
  const [removingBranch, setRemovingBranch] = useState(false);
  const [branchRemovalError, setBranchRemovalError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentLoadNonce, setContentLoadNonce] = useState(0);
  const [showAllTurns, setShowAllTurns] = useState(false);
  const [showFullTrace, setShowFullTrace] = useState(false);
  const [metadataNow, setMetadataNow] = useState(() => Date.now());
  const treeId = detail?.tree.id ?? null;
  const documentScrollRef = useRef<HTMLElement | null>(null);
  const followupTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const followupMenuRef = useRef<HTMLDivElement | null>(null);
  const navigationRef = useRef(researchNavigationStore());
  const navigationPersistTimerRef = useRef<number | null>(null);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const treeIdRef = useRef(treeId);
  // The content-loading effect reads the tree through this ref so a routine
  // detail replacement (every research event rebuilds the object) does not
  // restart the effect and refetch content that has not changed.
  const detailRef = useRef(detail);
  const previousDetailNodesRef = useRef<ResearchNode[]>([]);
  // Which node's content the scroll container is actually showing. Scroll
  // offsets must only be recorded while this matches the selection: a node
  // switch clears `content`, the article collapses to the loading block, and
  // the browser's clamp scroll event would otherwise overwrite the incoming
  // node's saved offset (usually with 0) before the restore effect reads it.
  const contentNodeIdRef = useRef<string | null>(null);
  selectedNodeIdRef.current = selectedNodeId;
  treeIdRef.current = treeId;
  detailRef.current = detail;
  contentNodeIdRef.current = content?.node.id ?? null;

  // Match the right-pane composer: fit the textarea to its contents up to the
  // shared cap, then let it scroll. The node dependency also sizes a newly
  // mounted empty composer after its content finishes loading.
  useEffect(() => {
    const textarea = followupTextareaRef.current;
    if (textarea) {
      growComposerTextarea(textarea);
    }
  }, [followup, content?.node.id]);

  // Resolve the plugin's namespaced deep-research command (e.g.
  // `/qmux:deep-research`) so deep follow-ups invoke the same skill the agent
  // launcher does. A missing plugin just leaves the literal fallback in place.
  useEffect(() => {
    let cancelled = false;
    void listClaudeSkills()
      .then((skills) => {
        if (!cancelled) {
          setDeepResearchSkillCommand(
            skills.find((skill) => skill.id === "deep-research")?.command ?? null,
          );
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  // Event-driven node metadata; fresher than content.node for anything that
  // does not require reparsing the transcript (status, checkpoint, children).
  const selectedDetailNode = useMemo(
    () => detail?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [detail, selectedNodeId],
  );
  const selectedNodeStatus = selectedDetailNode?.status ?? null;
  // The run is marked complete before the adapter finishes flushing, so the
  // fetch made on the status transition can read a truncated response. The
  // durable snapshot landing (stamped and announced by the backend) is the
  // signal that the final content exists — refetch when it appears.
  const selectedNodeSnapshotAt = selectedDetailNode?.responseSnapshotAt ?? null;
  const childNodes = useMemo(
    () =>
      detail && selectedNodeId
        ? detail.nodes.filter((node) => node.parentNodeId === selectedNodeId)
        : [],
    [detail, selectedNodeId],
  );
  const deletingBranch = useMemo(
    () =>
      deletingBranchId && detail
        ? {
            node: detail.nodes.find((node) => node.id === deletingBranchId) ?? null,
            info: researchBranchInfo(detail.nodes, deletingBranchId),
          }
        : null,
    [deletingBranchId, detail],
  );

  // Scroll offsets and selections for deleted nodes would otherwise sit in
  // localStorage forever (tree-level pruning happens in the app shell, which
  // does not know a tree's nodes).
  useEffect(() => {
    if (treeId && detail) {
      const validNodeIds = new Set(detail.nodes.map((node) => node.id));
      const previousNode = selectedNodeId
        ? previousDetailNodesRef.current.find((node) => node.id === selectedNodeId)
        : null;
      const fallbackNodeId =
        previousNode?.parentNodeId && validNodeIds.has(previousNode.parentNodeId)
          ? previousNode.parentNodeId
          : detail.tree.rootNodeId;
      pruneResearchNavigationNodes(
        treeId,
        [...validNodeIds],
      );
      setHistory((current) =>
        pruneResearchHistory(current, validNodeIds, fallbackNodeId),
      );
      if (selectedNodeId && !validNodeIds.has(selectedNodeId)) {
        const navigation = (navigationRef.current[treeId] ??= { scrollByNode: {} });
        navigation.selectedNodeId = fallbackNodeId;
        saveResearchNavigation();
        setSelectedNodeId(fallbackNodeId);
        setContent(null);
        setContentError(null);
      }
      previousDetailNodesRef.current = detail.nodes;
    }
  }, [detail, selectedNodeId, treeId]);

  useEffect(() => {
    if (!followupMenu) {
      return;
    }
    const closeMenu = (event: MouseEvent) => {
      if (!followupMenuRef.current?.contains(event.target as Node)) {
        setFollowupMenu(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFollowupMenu(null);
      }
    };
    const closeOnReflow = () => setFollowupMenu(null);
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnReflow);
    window.addEventListener("scroll", closeOnReflow, true);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnReflow);
      window.removeEventListener("scroll", closeOnReflow, true);
    };
  }, [followupMenu]);

  function openFollowupMenu(nodeId: string, clientX: number, clientY: number) {
    setFollowupMenu({
      nodeId,
      left: Math.max(
        FOLLOWUP_MENU_MARGIN,
        Math.min(clientX, window.innerWidth - FOLLOWUP_MENU_WIDTH - FOLLOWUP_MENU_MARGIN),
      ),
      top: Math.max(
        FOLLOWUP_MENU_MARGIN,
        Math.min(clientY, window.innerHeight - FOLLOWUP_MENU_HEIGHT - FOLLOWUP_MENU_MARGIN),
      ),
    });
  }

  function openAnswerMenu(trigger: HTMLButtonElement, nodeId: string) {
    if (followupMenu?.nodeId === nodeId) {
      setFollowupMenu(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    openFollowupMenu(nodeId, rect.right - FOLLOWUP_MENU_WIDTH, rect.bottom + 4);
  }

  async function confirmBranchRemoval() {
    if (!deletingBranch?.node || !deletingBranch.info || deletingBranch.info.hasActiveRuns) {
      return;
    }
    setBranchRemovalError(null);
    setRemovingBranch(true);
    try {
      if (deletingBranch.node.id === detail?.tree.rootNodeId) {
        await onRemoveTree(detail.tree.id);
        setDeletingBranchId(null);
        return;
      }
      const removal = await onRemoveBranch(deletingBranch.node.id);
      // The backend call and detail refresh can outlive this document's tree.
      // Never let a deletion started in the previous tree overwrite the new
      // tree's history or live node selection when it eventually resolves.
      if (treeIdRef.current !== removal.treeId) {
        setDeletingBranchId(null);
        return;
      }
      const removedNodeIds = new Set(removal.removedNodeIds);
      const validNodeIds = new Set(
        (detail?.nodes ?? [])
          .filter((node) => !removedNodeIds.has(node.id))
          .map((node) => node.id),
      );
      setHistory((current) => {
        const pruned = pruneResearchHistory(current, validNodeIds, removal.parentNodeId);
        return pruned.entries[pruned.index] === removal.parentNodeId
          ? pruned
          : pushResearchHistory(pruned, removal.parentNodeId);
      });
      // Deleting a child from the currently displayed parent's follow-up list
      // already leaves us on the right node. Clearing its content without
      // changing the selected id would not restart the content loader, leaving
      // the response body on its loading spinner indefinitely.
      if (isResearchNodeSelectionChange(selectedNodeIdRef.current, removal.parentNodeId)) {
        applySelection(removal.parentNodeId);
      }
      setDeletingBranchId(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setBranchRemovalError(message);
      onError(message);
    } finally {
      setRemovingBranch(false);
    }
  }

  useEffect(() => {
    const rootNodeId = detail?.tree.rootNodeId ?? null;
    const savedNodeId = treeId ? navigationRef.current[treeId]?.selectedNodeId : undefined;
    const selected =
      savedNodeId && detail?.nodes.some((node) => node.id === savedNodeId)
        ? savedNodeId
        : rootNodeId;
    setSelectedNodeId(selected);
    // A tree switch starts a fresh visit history rooted at the restored node.
    setHistory(initResearchHistory(selected));
    setContent(null);
    setContentError(null);
    // Restore the expanded window with the selection: the saved scroll offset
    // was captured against this state, and restoring one without the other
    // lands the viewport in the wrong place.
    setShowAllTurns(
      Boolean(treeId && selected && navigationRef.current[treeId]?.expandedByNode?.[selected]),
    );
  }, [treeId, detail?.tree.rootNodeId]);

  // Switches the displayed node without touching visit history: records the
  // outgoing node's scroll offset, clears content, and applies the selection.
  // Shared by user navigation (which then extends history) and back/forward
  // (which only moves the history cursor).
  const applySelection = useCallback(
    (nodeId: string) => {
      if (!treeId) {
        return;
      }
      const navigation = (navigationRef.current[treeId] ??= { scrollByNode: {} });
      if (
        selectedNodeId &&
        documentScrollRef.current &&
        contentNodeIdRef.current === selectedNodeId
      ) {
        navigation.scrollByNode[selectedNodeId] = documentScrollRef.current.scrollTop;
      }
      navigation.selectedNodeId = nodeId;
      saveResearchNavigation();
      setContent(null);
      setContentError(null);
      setShowAllTurns(Boolean(navigation.expandedByNode?.[nodeId]));
      setSelectedNodeId(nodeId);
    },
    [selectedNodeId, treeId],
  );

  const selectNode = useCallback(
    (nodeId: string) => {
      if (!treeId) {
        return;
      }
      // Clearing content without changing the node ID leaves the content loader's
      // dependencies unchanged, so clicking the current breadcrumb would show a
      // spinner forever. A current-node click is navigation-wise a no-op — except
      // as a retry affordance when the last load failed.
      if (!isResearchNodeSelectionChange(selectedNodeId, nodeId)) {
        if (contentError) {
          setContentLoadNonce((value) => value + 1);
        }
        return;
      }
      applySelection(nodeId);
      setHistory((prev) => pushResearchHistory(prev, nodeId));
    },
    [applySelection, contentError, selectedNodeId, treeId],
  );

  const canGoBack = historyCanGoBack(history);
  const canGoForward = historyCanGoForward(history);

  const goBack = useCallback(() => {
    const step = researchHistoryBack(history);
    if (!step) {
      return;
    }
    applySelection(step.nodeId);
    setHistory(step.history);
  }, [applySelection, history]);

  const goForward = useCallback(() => {
    const step = researchHistoryForward(history);
    if (!step) {
      return;
    }
    applySelection(step.nodeId);
    setHistory(step.history);
  }, [applySelection, history]);
  const goBackRef = useRef(goBack);
  const goForwardRef = useRef(goForward);
  goBackRef.current = goBack;
  goForwardRef.current = goForward;

  // Browser-style navigation shortcuts, active only while the document is
  // mounted (research surface visible). Cmd/Ctrl+[ / ] and Alt+←/→ mirror the
  // header arrows; the dedicated mouse back/forward buttons (3/4) do too. Keys
  // are ignored while typing so the follow-up composer keeps word-wise motion.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }
      const primary = event.metaKey || event.ctrlKey;
      let handler: (() => void) | null = null;
      if (primary && !event.altKey && !event.shiftKey && event.code === "BracketLeft") {
        handler = goBack;
      } else if (primary && !event.altKey && !event.shiftKey && event.code === "BracketRight") {
        handler = goForward;
      } else if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.key === "ArrowLeft"
      ) {
        handler = goBack;
      } else if (
        event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        event.key === "ArrowRight"
      ) {
        handler = goForward;
      }
      if (handler) {
        event.preventDefault();
        handler();
      }
    };
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 3) {
        event.preventDefault();
        goBack();
      } else if (event.button === 4) {
        event.preventDefault();
        goForward();
      }
    };
    const mouseTarget = documentScrollRef.current;
    window.addEventListener("keydown", onKeyDown);
    mouseTarget?.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      mouseTarget?.removeEventListener("mouseup", onMouseUp);
    };
  }, [goBack, goForward]);

  // Trackpads and horizontal mouse wheels both arrive as WheelEvents. Accumulate
  // one physical gesture until its horizontal travel is decisive, navigate once,
  // then keep the gesture locked through momentum events until it goes idle.
  // Descendant code/preformatted scrollers retain their native horizontal scroll
  // whenever they can still consume movement in the requested direction.
  useEffect(() => {
    const target = documentScrollRef.current;
    if (!target) {
      return;
    }
    let accumulatedX = 0;
    let accumulatedY = 0;
    let navigated = false;
    let blockedByScroller = false;
    let resetTimer: number | null = null;
    const resetGesture = () => {
      if (resetTimer !== null) {
        window.clearTimeout(resetTimer);
      }
      accumulatedX = 0;
      accumulatedY = 0;
      navigated = false;
      blockedByScroller = false;
      resetTimer = null;
    };
    const scheduleReset = () => {
      if (resetTimer !== null) {
        window.clearTimeout(resetTimer);
      }
      resetTimer = window.setTimeout(resetGesture, RESEARCH_SWIPE_IDLE_MS);
    };
    const onWheel = (event: WheelEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? target.clientWidth
          : 1;
      const deltaX = event.deltaX * scale;
      const deltaY = event.deltaY * scale;
      if (horizontalScrollerConsumesWheel(event.target, target, deltaX)) {
        blockedByScroller = true;
        scheduleReset();
        return;
      }
      if (blockedByScroller) {
        scheduleReset();
        return;
      }
      scheduleReset();
      accumulatedX += deltaX;
      accumulatedY += deltaY;
      const horizontalIntent = Math.abs(accumulatedX) > Math.abs(accumulatedY) * 1.25;
      if (navigated) {
        if (horizontalIntent) {
          event.preventDefault();
        }
        return;
      }
      const direction = researchSwipeDirection(accumulatedX, accumulatedY);
      if (direction === 0) {
        return;
      }
      event.preventDefault();
      navigated = true;
      if (direction < 0) {
        goBackRef.current();
      } else {
        goForwardRef.current();
      }
    };
    target.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      target.removeEventListener("wheel", onWheel);
      if (resetTimer !== null) {
        window.clearTimeout(resetTimer);
      }
    };
  }, [Boolean(detail && selectedNodeId)]);

  const expandAllTurns = useCallback(() => {
    setShowAllTurns(true);
    if (treeId && selectedNodeId) {
      const navigation = (navigationRef.current[treeId] ??= { scrollByNode: {} });
      (navigation.expandedByNode ??= {})[selectedNodeId] = true;
      saveResearchNavigation();
    }
  }, [selectedNodeId, treeId]);

  useEffect(() => {
    if (!selectedNodeId) {
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    let consecutiveErrors = 0;
    // A restart of this effect is a fresh load (status transition, snapshot
    // landing, retry): a failure reported by the *previous* run must not sit
    // on screen while this one is in flight. Failures within one run keep
    // their error up across the backoff retries.
    setContentError(null);
    const load = async () => {
      try {
        const next = await getResearchNodeContent(selectedNodeId);
        if (cancelled) {
          return;
        }
        consecutiveErrors = 0;
        setContentError(null);
        setContent(next);
        if (["queued", "starting", "running"].includes(next.node.status)) {
          timer = window.setTimeout(load, 1000);
        }
      } catch (err) {
        if (!cancelled) {
          setContentError(err instanceof Error ? err.message : String(err));
          const knownNode = detailRef.current?.nodes.find((node) => node.id === selectedNodeId);
          consecutiveErrors += 1;
          const isActive =
            knownNode && ["queued", "starting", "running"].includes(knownNode.status);
          if (isActive || consecutiveErrors <= 5) {
            timer = window.setTimeout(load, Math.min(5000, 1000 * consecutiveErrors));
          }
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
    // Keyed on the node's *status* rather than the detail object: streaming
    // runs replace `detail` on every event, and restarting this effect for
    // each replacement refetched and reparsed unchanged content. A status
    // transition still restarts it, which is what fetches the final content
    // once the run completes — and the snapshot stamp restarts it once more
    // if that fetch beat the adapter's final transcript flush.
  }, [selectedNodeId, selectedNodeStatus, selectedNodeSnapshotAt, contentLoadNonce]);

  useLayoutEffect(() => {
    if (!treeId || !content || !documentScrollRef.current) {
      return;
    }
    const saved = navigationRef.current[treeId]?.scrollByNode?.[content.node.id] ?? 0;
    documentScrollRef.current.scrollTop = saved;
  }, [content?.node.id, treeId]);

  useEffect(() => {
    if (treeId && selectedNodeId && detail?.nodes.some((node) => node.id === selectedNodeId)) {
      const navigation = (navigationRef.current[treeId] ??= { scrollByNode: {} });
      // `detail.nodes` is a fresh array on every research event; without the
      // guard a streaming run rewrote localStorage several times a second.
      if (navigation.selectedNodeId !== selectedNodeId) {
        navigation.selectedNodeId = selectedNodeId;
        saveResearchNavigation();
      }
    }
  }, [detail?.nodes, selectedNodeId, treeId]);

  useEffect(
    () => () => {
      if (navigationPersistTimerRef.current !== null) {
        window.clearTimeout(navigationPersistTimerRef.current);
      }
      const currentTreeId = treeIdRef.current;
      const currentNodeId = selectedNodeIdRef.current;
      if (
        currentTreeId &&
        currentNodeId &&
        documentScrollRef.current &&
        contentNodeIdRef.current === currentNodeId
      ) {
        const navigation = (navigationRef.current[currentTreeId] ??= { scrollByNode: {} });
        navigation.scrollByNode[currentNodeId] = documentScrollRef.current.scrollTop;
      }
      saveResearchNavigation();
    },
    [],
  );

  const recordScroll = useCallback(() => {
    if (!treeId || !selectedNodeId || !documentScrollRef.current) {
      return;
    }
    // Loading/stale windows are not this node's scroll state (see the ref's
    // comment) — without this, navigating to a node wipes its saved offset.
    if (contentNodeIdRef.current !== selectedNodeId) {
      return;
    }
    const navigation = (navigationRef.current[treeId] ??= { scrollByNode: {} });
    navigation.scrollByNode[selectedNodeId] = documentScrollRef.current.scrollTop;
    if (navigationPersistTimerRef.current !== null) {
      window.clearTimeout(navigationPersistTimerRef.current);
    }
    navigationPersistTimerRef.current = window.setTimeout(() => {
      navigationPersistTimerRef.current = null;
      saveResearchNavigation();
    }, 250);
  }, [selectedNodeId, treeId]);

  const breadcrumb = useMemo(() => {
    if (!detail || !selectedNodeId) {
      return [];
    }
    const byId = new Map(detail.nodes.map((node) => [node.id, node]));
    const path: ResearchNode[] = [];
    let node = byId.get(selectedNodeId);
    const seen = new Set<string>();
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      path.unshift(node);
      node = node.parentNodeId ? byId.get(node.parentNodeId) : undefined;
    }
    return path;
  }, [detail, selectedNodeId]);

  const followupNode = selectedDetailNode ?? content?.node ?? null;
  // Normalize the complete response before windowing it. The resulting item
  // boundaries keep a call and its result together and preserve text → tools →
  // continued-text ordering across every adapter's transcript role choices.
  const timelineItems = useMemo(
    () => buildTimelineItems(content?.turns ?? []),
    [content?.turns],
  );
  const answerTimelineItems = useMemo(
    () => timelineItemsAfterLastToolCall(timelineItems),
    [timelineItems],
  );
  const hasTranscriptActivity = timelineItemsContainTranscriptActivity(timelineItems);
  const displayedTimelineItems = showFullTrace ? timelineItems : answerTimelineItems;
  const visibleTimelineItems =
    showAllTurns || displayedTimelineItems.length <= TIMELINE_ITEM_RENDER_WINDOW
      ? displayedTimelineItems
      : displayedTimelineItems.slice(-TIMELINE_ITEM_RENDER_WINDOW);
  const hiddenTimelineItemCount = displayedTimelineItems.length - visibleTimelineItems.length;
  const rawAnswer = useMemo(
    () => assistantTextFromTimelineItems(answerTimelineItems),
    [answerTimelineItems],
  );
  // Memoized because this component renders several times a second while a run
  // streams (detail replacements, the duration tick, every composer keystroke),
  // and the regex walks — and allocates a match array over — the entire answer.
  const answerWordCount = useMemo(() => countWords(rawAnswer), [rawAnswer]);

  async function submitFollowup() {
    const prompt = followup.trim();
    // Mirrors the submit button's disabled conditions: Cmd+Enter must not
    // reach the backend (and bounce with an error) from a state the button
    // presents as unavailable — a running node already has a session id.
    if (
      archived ||
      !followupNode ||
      !prompt ||
      submitting ||
      followupNode.status !== "complete" ||
      !followupNode.nativeSessionId
    ) {
      return;
    }
    setSubmitting(true);
    // Deep research is a submit-time prefix, never shown in the composer: the
    // plugin's namespaced skill command when the node runs on Claude, a plain
    // `/deep-research` otherwise.
    const deepCommand =
      followupNode.adapter === CLAUDE_ADAPTER_ID && deepResearchSkillCommand
        ? deepResearchSkillCommand
        : "/deep-research";
    const finalPrompt = followupMode === "deep" ? `${deepCommand} ${prompt}` : prompt;
    try {
      // The new child lands in the tree detail (refreshed by the fork flow),
      // which is where the follow-up cards render from.
      const child = await onFork(followupNode.id, finalPrompt);
      setFollowup("");
      // The fork round trip spans a real agent spawn, so the user can switch
      // trees while it is in flight. Following the child then would hijack
      // whatever tree is now displayed: this closure's selectNode records
      // navigation for the submit-time tree but sets the live selection to a
      // node the displayed tree does not contain. The child still exists and
      // its card appears when its own tree is next opened.
      if (treeIdRef.current === treeId) {
        selectNode(child.id);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Prefer the event-driven node over the last content fetch for metadata:
  // detail updates arrive without reparsing the transcript. The chrome
  // (breadcrumb, prompt, follow-ups) renders from this alone, so switching
  // nodes no longer blanks the whole document while content loads — only the
  // response section waits for the fetch.
  const displayNode = selectedDetailNode ?? content?.node ?? null;

  useEffect(() => {
    setMetadataNow(Date.now());
    if (!displayNode || !["queued", "starting", "running"].includes(displayNode.status)) {
      return;
    }
    const timer = window.setInterval(() => setMetadataNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [displayNode?.id, displayNode?.status]);

  const generationDuration = displayNode?.startedAt
    ? (displayNode.completedAt ?? metadataNow) - displayNode.startedAt
    : null;
  const generationActive = Boolean(
    displayNode && ["queued", "starting", "running"].includes(displayNode.status),
  );

  async function copyAnswer() {
    if (!rawAnswer) {
      return;
    }
    try {
      await writeClipboardText(rawAnswer);
      onToast("Copied research answer");
    } catch {
      onToast("Couldn’t copy the research answer", "warning");
    }
  }

  if (!detail || !displayNode) {
    // A failed *tree* fetch retries through the app shell — without detail
    // there is no node to load, so no in-document retry can recover.
    const placeholderError = detail ? contentError : detailError ?? null;
    const retry = detail
      ? () => setContentLoadNonce((value) => value + 1)
      : onRetryDetail;
    const headerTitle = detail?.tree.title ?? treeTitle ?? "Loading research…";
    return (
      <div className="research-workspace">
        <main className="research-document">
          <header className="research-document-header">
            <div className="research-history-nav" aria-label="Research history">
              <button
                type="button"
                className="research-history-button"
                disabled
                aria-label="Back"
              >
                <ArrowLeft size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="research-history-button"
                disabled
                aria-label="Forward"
              >
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="research-breadcrumb" aria-label="Research path">
              <span>
                <button type="button" disabled>
                  {headerTitle}
                </button>
              </span>
            </div>
          </header>
          <div className="research-placeholder">
            {placeholderError ? null : (
              <LoaderCircle className="research-spinner" size={24} aria-hidden="true" />
            )}
            <h1>{placeholderError ? "Research unavailable" : "Loading research…"}</h1>
            {placeholderError ? (
              <>
                <p role="alert">{placeholderError}</p>
                {retry ? (
                  <button type="button" onClick={retry}>
                    Retry
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </main>
      </div>
    );
  }

  const activeRun = ["queued", "starting", "running"].includes(displayNode.status);
  const cancellationNeedsRetry = displayNode.status === "cancelled" && Boolean(displayNode.paneId);
  const followupCount = Math.max(0, detail.nodes.length - 1);

  return (
    <TranscriptLinkActionsProvider actions={linkActions}>
      <>
        <div className="research-workspace">
        <main className="research-document">
          <header className="research-document-header">
            <div className="research-history-nav" aria-label="Research history">
              <button
                type="button"
                className="research-history-button"
                disabled={!canGoBack}
                title={`Back (${IS_MAC ? "⌘[" : "Ctrl+["})`}
                aria-label="Back"
                onClick={goBack}
              >
                <ArrowLeft size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="research-history-button"
                disabled={!canGoForward}
                title={`Forward (${IS_MAC ? "⌘]" : "Ctrl+]"})`}
                aria-label="Forward"
                onClick={goForward}
              >
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="research-breadcrumb" aria-label="Research path">
              {breadcrumb.map((node, index) => (
                <span key={node.id}>
                  {index > 0 ? <span className="research-breadcrumb-separator">/</span> : null}
                  <button type="button" onClick={() => selectNode(node.id)}>
                    {index === 0 ? detail.tree.title : node.title ?? node.prompt}
                  </button>
                </span>
              ))}
            </div>
            {followupCount > 0 ? (
              <span className="research-document-followup-count">
                {followupCount} {followupCount === 1 ? "follow-up" : "follow-ups"}
              </span>
            ) : null}
            {hasTranscriptActivity ? (
              <button
                type="button"
                className={`research-trace-toggle${showFullTrace ? " is-active" : ""}`}
                aria-pressed={showFullTrace}
                title={showFullTrace ? "Hide full transcript" : "Show full transcript"}
                aria-label={showFullTrace ? "Hide full transcript" : "Show full transcript"}
                onClick={() => setShowFullTrace((current) => !current)}
              >
                <ScrollText size={15} aria-hidden="true" />
              </button>
            ) : null}
            {displayNode.paneId && (activeRun || cancellationNeedsRetry) ? (
              <button
                type="button"
                className="research-open-terminal"
                onClick={() => onOpenPane(displayNode.paneId!)}
              >
                <ExternalLink size={14} aria-hidden="true" />
                Open terminal
              </button>
            ) : null}
            {activeRun || cancellationNeedsRetry ? (
              <button
                type="button"
                className="research-cancel-run"
                disabled={cancelling}
                onClick={() => {
                  const nodeId = displayNode.id;
                  setCancelling(true);
                  onCancel(nodeId)
                    .catch((err) => onError(err instanceof Error ? err.message : String(err)))
                    .finally(() => setCancelling(false));
                }}
              >
                <X size={14} aria-hidden="true" />
                {cancelling
                  ? "Cancelling…"
                  : cancellationNeedsRetry
                    ? "Retry cancel"
                    : "Cancel"}
              </button>
            ) : null}
          </header>

          <article
            ref={documentScrollRef}
            className="research-document-scroll"
            onScroll={recordScroll}
          >
            <div className="research-document-content">
              <div className="research-prompt">
                {displayNode.parentNodeId ? (
                  <button
                    type="button"
                    className="research-parent-link"
                    onClick={() => selectNode(displayNode.parentNodeId!)}
                  >
                    <ArrowLeft size={13} aria-hidden="true" />
                    Back
                  </button>
                ) : null}
                <TranscriptMarkdown text={displayNode.prompt} imageBehavior="open" inline />
              </div>
              <div className="research-response-grid">
                <section className="research-response" aria-label="Research response">
                  {!content ? (
                    <div className="research-response-loading">
                      {contentError ? (
                        <>
                          <p role="alert">{contentError}</p>
                          <button
                            type="button"
                            onClick={() => setContentLoadNonce((value) => value + 1)}
                          >
                            Retry
                          </button>
                        </>
                      ) : (
                        <LoaderCircle
                          className="research-spinner"
                          size={18}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  ) : (
                    <>
                  {contentError ? (
                    // A refetch failure with stale content on screen (the
                    // final post-completion fetch, a mid-run poll) would
                    // otherwise be invisible: the loading-branch error above
                    // only renders while nothing is loaded, silently passing
                    // off the last loaded response as current.
                    <div className="research-response-stale" role="alert">
                      <p>Refreshing this response failed: {contentError}</p>
                      <button
                        type="button"
                        onClick={() => setContentLoadNonce((value) => value + 1)}
                      >
                        Retry
                      </button>
                    </div>
                  ) : null}
                  {displayNode.status === "failed" && content.turns.length > 0 ? (
                    <p className="research-response-error" role="alert">
                      {displayNode.error ?? "The research run failed."}
                    </p>
                  ) : null}
                  {displayedTimelineItems.length === 0 ? (
                    <p className="research-response-empty">
                      {displayNode.status === "failed"
                        ? displayNode.error ?? "The research run failed."
                        : displayNode.status === "cancelled"
                          ? "Research was cancelled."
                          : content.sourceError
                            ? `The response is no longer available: ${content.sourceError}`
                            : displayNode.status === "complete"
                              ? "Research completed, but its response is unavailable. Open the original session transcript if it still exists."
                              : ["queued", "starting", "running"].includes(displayNode.status)
                                ? timelineItems.length > 0
                                  ? "Waiting for the final response…"
                                  : "Waiting for the response…"
                                : "No response is available."}
                    </p>
                  ) : (
                    <>
                      {hiddenTimelineItemCount > 0 ? (
                        <button
                          type="button"
                          className="research-show-earlier"
                          onClick={expandAllTurns}
                        >
                          Show {hiddenTimelineItemCount} earlier response item
                          {hiddenTimelineItemCount === 1 ? "" : "s"}
                        </button>
                      ) : null}
                      <div className="research-response-content-root">
                        {visibleTimelineItems.map((item) => (
                          <ResearchTimelineItem key={item.key} item={item} />
                        ))}
                      </div>
                    </>
                  )}
                    </>
                  )}
                  {content ? (
                    <footer className="research-answer-meta">
                      <span>
                        {answerWordCount.toLocaleString()}{" "}
                        {answerWordCount === 1 ? "word" : "words"}
                      </span>
                      {generationDuration !== null ? (
                        <span>
                          {generationActive ? (
                            <>Generating for{" "}</>
                          ) : displayNode.status !== "complete" ? (
                            <>Ran for{" "}</>
                          ) : null}
                          {formatDuration(generationDuration)}
                        </span>
                      ) : generationActive ? (
                        <span>Waiting to start</span>
                      ) : null}
                      {displayNode.status === "complete" && rawAnswer ? (
                        <button
                          type="button"
                          className="research-answer-copy"
                          title="Copy answer as Markdown"
                          aria-label="Copy answer as Markdown"
                          onClick={() => void copyAnswer()}
                        >
                          <Copy size={14} aria-hidden="true" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="research-answer-menu-trigger"
                        title="Answer actions"
                        aria-label="Answer actions"
                        aria-haspopup="menu"
                        aria-expanded={followupMenu?.nodeId === displayNode.id}
                        onClick={(event) => openAnswerMenu(event.currentTarget, displayNode.id)}
                      >
                        <MoreHorizontal size={15} aria-hidden="true" />
                      </button>
                    </footer>
                  ) : null}
                </section>

                <aside className="research-followups" aria-label="Follow-ups">
                  <div
                    className={`research-followup-composer${
                      archived || displayNode.status !== "complete" ? " is-disabled" : ""
                    }`}
                  >
                    <div
                      className="sidebar-mode-toggle research-followup-mode-toggle"
                      role="tablist"
                      aria-label="Follow-up mode"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={followupMode === "ask"}
                        className={followupMode === "ask" ? "is-selected" : undefined}
                        disabled={archived || displayNode.status !== "complete"}
                        onClick={() => setFollowupMode("ask")}
                      >
                        <span>Ask about</span>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={followupMode === "deep"}
                        className={followupMode === "deep" ? "is-selected" : undefined}
                        disabled={archived || displayNode.status !== "complete"}
                        onClick={() => setFollowupMode("deep")}
                      >
                        <span>Deep research</span>
                      </button>
                    </div>
                    <textarea
                      ref={followupTextareaRef}
                      value={followup}
                      placeholder={
                        followupMode === "deep"
                          ? "Type your research query…"
                          : "Type your query…"
                      }
                      aria-label="Follow-up question"
                      disabled={archived || displayNode.status !== "complete"}
                      onChange={(event) => setFollowup(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          void submitFollowup();
                        }
                      }}
                      rows={2}
                    />
                    <div className="native-input-submit-actions">
                      <button
                        type="button"
                        disabled={
                          archived ||
                          !followup.trim() ||
                          submitting ||
                          displayNode.status !== "complete" ||
                          !displayNode.nativeSessionId
                        }
                        onClick={() => void submitFollowup()}
                      >
                        <span>{submitting ? "Sending…" : "Send"}</span>
                        {!submitting ? (
                          <ComposerSubmitShortcutGlyph
                            requireCmdEnter
                            className="shortcut-hint"
                          />
                        ) : null}
                      </button>
                    </div>
                    {!archived &&
                    displayNode.status === "complete" &&
                    !displayNode.nativeSessionId ? (
                      <small>Waiting for the native session checkpoint before branching.</small>
                    ) : null}
                  </div>
                  <div className="research-followup-cards">
                    {childNodes.map((child) => (
                      <button
                        key={child.id}
                        type="button"
                        className="research-followup-card"
                        onClick={() => selectNode(child.id)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          openFollowupMenu(child.id, event.clientX, event.clientY);
                        }}
                      >
                        <strong>{child.prompt}</strong>
                        {child.responsePreview ? (
                          <TranscriptMarkdown
                            text={child.responsePreview}
                            className="research-followup-preview"
                            imageBehavior="open"
                            inline
                          />
                        ) : null}
                        {child.status !== "complete" ? (
                          <small className={`is-${child.status}`}>{statusLabel(child.status)}</small>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </aside>
              </div>
            </div>
          </article>
        </main>
        </div>
        {followupMenu && detail
          ? (() => {
              const node = detail.nodes.find((candidate) => candidate.id === followupMenu.nodeId);
              const info = researchBranchInfo(detail.nodes, followupMenu.nodeId);
              if (!node || !info) {
                return null;
              }
              const label = info.descendantCount > 0 ? "Delete branch" : "Delete follow-up";
              const rootNode = node.id === detail.tree.rootNodeId;
              return createPortal(
                <div
                  ref={followupMenuRef}
                  className="pane-context-menu research-followup-menu"
                  role="menu"
                  aria-label={`Actions for ${node.title ?? node.prompt}`}
                  style={{ left: followupMenu.left, top: followupMenu.top }}
                  onMouseDown={(event) => event.stopPropagation()}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  <div className="group-context-actions">
                    <button
                      type="button"
                      role="menuitem"
                      className="context-menu-danger"
                      disabled={info.hasActiveRuns}
                      title={
                        info.hasActiveRuns
                          ? "This branch must finish or be cancelled before deletion"
                          : undefined
                      }
                      onClick={() => {
                        setFollowupMenu(null);
                        setBranchRemovalError(null);
                        setDeletingBranchId(node.id);
                      }}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                      <span>{rootNode ? "Delete research" : label}</span>
                    </button>
                  </div>
                </div>,
                document.body,
              );
            })()
          : null}
        {deletingBranch?.node && deletingBranch.info
          ? createPortal(
              <div
                className="confirm-dialog-backdrop"
                role="presentation"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget && !removingBranch) {
                    setDeletingBranchId(null);
                  }
                }}
              >
                <div
                  className="confirm-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="delete-research-branch-dialog-title"
                  aria-busy={removingBranch}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && !removingBranch) {
                      event.preventDefault();
                      setDeletingBranchId(null);
                    }
                  }}
                >
                  <h2 id="delete-research-branch-dialog-title">
                    {deletingBranch.node.id === detail.tree.rootNodeId
                      ? "Delete research"
                      : deletingBranch.info.descendantCount > 0
                      ? "Delete this research branch?"
                      : "Delete this follow-up?"}
                  </h2>
                  <p>Delete "{deletingBranch.node.title ?? deletingBranch.node.prompt}"?</p>
                  <p>
                    {deletingBranch.node.id === detail.tree.rootNodeId
                      ? deletingBranch.info.descendantCount > 0
                        ? `This permanently deletes the root answer and all ${deletingBranch.info.descendantCount} follow-up${deletingBranch.info.descendantCount === 1 ? "" : "s"}.`
                        : "This permanently deletes the root answer and its research history."
                      : deletingBranch.info.descendantCount > 0
                      ? `This also permanently deletes ${deletingBranch.info.descendantCount} descendant follow-up${deletingBranch.info.descendantCount === 1 ? "" : "s"}.`
                      : "This permanently deletes the follow-up and its response."} {" "}
                    This can’t be undone.
                  </p>
                  {branchRemovalError ? (
                    <p className="confirm-dialog-error" role="alert">
                      {branchRemovalError}
                    </p>
                  ) : null}
                  <div className="confirm-dialog-actions">
                    <button
                      type="button"
                      disabled={removingBranch}
                      onClick={() => setDeletingBranchId(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="danger"
                      autoFocus
                      disabled={removingBranch || deletingBranch.info.hasActiveRuns}
                      onClick={() => void confirmBranchRemoval()}
                    >
                      {removingBranch
                        ? "Deleting…"
                        : deletingBranch.node.id === detail.tree.rootNodeId
                          ? "Delete research"
                          : deletingBranch.info.descendantCount > 0
                          ? "Delete branch"
                          : "Delete follow-up"}
                    </button>
                  </div>
                </div>
              </div>,
              document.body,
            )
          : null}
      </>
    </TranscriptLinkActionsProvider>
  );
}
