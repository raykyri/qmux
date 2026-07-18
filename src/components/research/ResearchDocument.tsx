import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Check, Copy, ExternalLink, LoaderCircle, MoreHorizontal, Pencil, RefreshCw, ScrollText, Share2, Trash2, X } from "lucide-react";
import { IS_MAC, isEditableTarget } from "../../lib/appHelpers";
import {
  createResearchHighlight,
  getResearchNodeContent,
  getResearchTree,
  listPublicationProposals,
  removeResearchHighlights,
  resolvePublicationProposal,
} from "../../lib/api";
import { writeClipboardText } from "../../lib/clipboard";
import { growComposerTextarea } from "../../lib/composerTextarea";
import type {
  PublicationBinding,
  PublicationProposal,
} from "../../lib/publication";
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
import { countResearchDocumentWords } from "../../lib/researchDocuments";
import {
  expandedResearchHighlightOffsets,
  intersectingResearchHighlightIds,
  isResearchAskActionShortcut,
  isResearchExpandActionShortcut,
  isResearchHighlightActionShortcut,
  resolveResearchHighlightOffset,
} from "../../lib/researchHighlights";
import {
  isResearchNodeSelectionChange,
  pruneResearchNavigationNodes,
  recordResearchScrollPosition,
  researchNavigationStore,
  restoreResearchScrollPosition,
  saveResearchNavigation,
} from "../../lib/researchNavigation";
import {
  assistantTextFromTimelineItems,
  buildTimelineItems,
  timelineItemsAfterLastToolCall,
  timelineItemsContainTranscriptActivity,
} from "../../lib/turnTimeline";
import {
  createResearchPublicationDraft,
  researchNodeSnapshotMatches,
} from "../../lib/publicationDrafts";
import type { MessageBlock, MessageItem } from "../../lib/turnTimeline";
import type {
  ResearchBranchRemoval,
  ResearchHighlight,
  ResearchHighlightAnchor,
  ResearchNode,
  ResearchNodeContent,
  ResearchTreeDetail,
  UpdateResearchDocumentResult,
} from "../../types";
import { ComposerSubmitShortcutGlyph } from "../ComposerSubmitShortcut";
import DomSearchBar from "../DomSearchBar";
import type { PublishDialogTarget } from "../PublishDialog";
import {
  RawTranscriptDisclosure,
  TranscriptActivityItem,
  timelineStatusClass,
} from "../TranscriptActivity";
import TranscriptMarkdown, {
  TranscriptLinkActionsProvider,
  type LinkActions,
} from "../TranscriptMarkdown";
import DocumentDialog from "./DocumentDialog";

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
  onFork: (
    parentNodeId: string,
    prompt: string,
    publicationProposal?: {
      publicationId: string;
      commentId: number;
    } | null,
    queryAnchor?: ResearchHighlightAnchor | null,
  ) => Promise<ResearchNode>;
  onRemoveBranch: (nodeId: string) => Promise<ResearchBranchRemoval>;
  onRemoveTree: (treeId: string) => Promise<void>;
  onUpdateDocument: (input: {
    nodeId: string;
    markdown: string;
    title: string | null;
    expectedResponseRevision: string;
    expectedTitle: string;
    expectedHighlightIds: string[];
  }) => Promise<UpdateResearchDocumentResult>;
  onCancel: (nodeId: string) => Promise<void>;
  onOpenPane: (paneId: string) => void;
  linkActions: LinkActions;
  onError: (message: string) => void;
  onToast: (message: string, tone?: "normal" | "warning") => void;
  onPublish: (target: PublishDialogTarget) => void;
  publicationBinding?: PublicationBinding | null;
  onPublicationBindingChange: (binding: PublicationBinding) => void;
}

// The backend caps snapshots at 64MB, which is still far beyond what markdown
// parsing and eager React element creation can absorb without freezing the
// interface. Blocks past this size render as plain preformatted text — itself
// display-capped, since laying out a multi-megabyte text node freezes the interface
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
const FOLLOWUP_MENU_HEIGHT = 154;
const DOCUMENT_MENU_HEIGHT = 196;
const FOLLOWUP_MENU_MARGIN = 8;

interface FollowupMenu {
  nodeId: string;
  left: number;
  top: number;
}

interface HighlightAction {
  anchor: ResearchHighlightAnchor;
  highlightIds: string[];
  /** The merged annotation an Expand action would save — the union of the
   * selection and every highlight it intersects. Null when there is nothing
   * to expand. */
  expandAnchor: ResearchHighlightAnchor | null;
  /** Viewport boxes framing the selected annotations, one per rendered line
   * fragment. Empty when the selection touches no saved highlight. */
  outlineRects: HighlightOutlineRect[];
  left: number;
  top: number;
  /** The selection has scrolled out of the viewport: keep the action alive
   * but stop drawing a bar over unrelated content. */
  offscreen: boolean;
}

interface ResolvedHighlight {
  highlight: ResearchHighlight;
  start: number;
  end: number;
}

interface DocumentEditSession {
  nodeId: string;
  markdown: string;
  title: string;
  responseRevision: string;
  highlightIds: string[];
  highlightCount: number;
}

interface ResearchHighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

interface ResearchNativeHighlight {
  add(range: Range): void;
  priority: number;
}

interface ResearchHighlightApi {
  registry: ResearchHighlightRegistry;
  Highlight: new () => ResearchNativeHighlight;
}

const RESEARCH_HIGHLIGHT_NAME = "qmux-research-highlights";
const RESEARCH_QUERY_ANCHOR_NAME = "qmux-research-query-anchors";
const RESEARCH_ANCHOR_LINK_NAME = "qmux-research-anchor-link";
const RESEARCH_SELECTED_NAME = "qmux-research-selected-highlights";
const RESEARCH_HIGHLIGHT_CONTEXT_LENGTH = 128;
// Clearance between the anchored composer's bottom edge and the first pushed
// follow-up card.
const ASK_COMPOSER_CLEARANCE = 20;
// Minimum vertical gap between anchored cards after collision resolution.
// Tighter than the stacked rail's 20px so a cascaded cluster stays visually
// attached to the passage that produced it.
const ANCHORED_CARD_GAP = 12;

function researchHighlightApi(): ResearchHighlightApi | null {
  const css = (globalThis as unknown as { CSS?: { highlights?: ResearchHighlightRegistry } }).CSS;
  const Highlight = (globalThis as unknown as { Highlight?: unknown }).Highlight;
  if (!css?.highlights || typeof Highlight !== "function") {
    return null;
  }
  return {
    registry: css.highlights,
    Highlight: Highlight as new () => ResearchNativeHighlight,
  };
}

function textNodesWithin(root: HTMLElement) {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

function rangeForTextOffsets(root: HTMLElement, start: number, end: number) {
  if (start < 0 || end <= start) {
    return null;
  }
  const nodes = textNodesWithin(root);
  let consumed = 0;
  let startPoint: { node: Text; offset: number } | null = null;
  let endPoint: { node: Text; offset: number } | null = null;
  for (const node of nodes) {
    const next = consumed + node.data.length;
    if (!startPoint && start <= next) {
      startPoint = { node, offset: start - consumed };
    }
    if (end <= next) {
      endPoint = { node, offset: end - consumed };
      break;
    }
    consumed = next;
  }
  if (!startPoint || !endPoint) {
    return null;
  }
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

function selectionOffsets(root: HTMLElement, range: Range) {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }
  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(root);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const throughSelectionRange = document.createRange();
  throughSelectionRange.selectNodeContents(root);
  throughSelectionRange.setEnd(range.endContainer, range.endOffset);
  const start = prefixRange.cloneContents().textContent?.length ?? 0;
  const end = throughSelectionRange.cloneContents().textContent?.length ?? 0;
  return end > start ? { start, end } : null;
}

/** The flat rendered-text offset of a caret position, or null when the
 * position sits outside `root`. Text-node positions take the cheap walking
 * path; element positions (rare — clicks on gaps between blocks) fall back to
 * the same clone-and-measure approach as `selectionOffsets`. */
function flatTextOffsetAt(root: HTMLElement, node: Node, offsetInNode: number) {
  if (!root.contains(node)) {
    return null;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    let consumed = 0;
    for (const textNode of textNodesWithin(root)) {
      if (textNode === node) {
        return consumed + Math.min(offsetInNode, textNode.data.length);
      }
      consumed += textNode.data.length;
    }
    return null;
  }
  const probe = document.createRange();
  probe.selectNodeContents(root);
  try {
    probe.setEnd(node, offsetInNode);
  } catch {
    return null;
  }
  return probe.cloneContents().textContent?.length ?? 0;
}

/** Hit-tests a viewport point against the rendered text: the flat offset the
 * point falls on, or null off-text. caretRangeFromPoint is the WebKit spelling,
 * caretPositionFromPoint the standard one. */
function flatOffsetAtPoint(root: HTMLElement, clientX: number, clientY: number) {
  const doc = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(clientX, clientY);
    return range ? flatTextOffsetAt(root, range.startContainer, range.startOffset) : null;
  }
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(clientX, clientY);
    return position ? flatTextOffsetAt(root, position.offsetNode, position.offset) : null;
  }
  return null;
}

function textContextSlice(text: string, start: number, end: number) {
  let safeStart = Math.max(0, start);
  let safeEnd = Math.min(text.length, end);
  if (
    safeStart > 0 &&
    safeStart < text.length &&
    /[\uDC00-\uDFFF]/.test(text[safeStart]) &&
    /[\uD800-\uDBFF]/.test(text[safeStart - 1])
  ) {
    safeStart -= 1;
  }
  if (
    safeEnd > 0 &&
    safeEnd < text.length &&
    /[\uD800-\uDBFF]/.test(text[safeEnd - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[safeEnd])
  ) {
    safeEnd += 1;
  }
  return text.slice(safeStart, safeEnd);
}

/** The quoted selection as a single line: block structure and inline markdown
 * are already absent from the rendered-text projection, so collapsing
 * whitespace is all that quoting requires. */
function quoteDisplayText(exact: string) {
  return exact.split(/\s+/).join(" ").trim();
}

interface HighlightOutlineRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Viewport boxes around the resolved ranges of the given saved highlights.
 * A wrapped annotation gets one box per rendered line, merging the
 * per-text-node rects the range reports along that line. */
function highlightOutlineRects(
  root: HTMLElement,
  resolved: ResolvedHighlight[],
  highlightIds: string[],
): HighlightOutlineRect[] {
  const boxes: HighlightOutlineRect[] = [];
  for (const { highlight, start, end } of resolved) {
    if (!highlightIds.includes(highlight.id)) {
      continue;
    }
    const range = rangeForTextOffsets(root, start, end);
    if (!range) {
      continue;
    }
    const lines: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const line = lines.find(
        (candidate) => rect.top < candidate.bottom && rect.bottom > candidate.top,
      );
      if (line) {
        line.left = Math.min(line.left, rect.left);
        line.top = Math.min(line.top, rect.top);
        line.right = Math.max(line.right, rect.right);
        line.bottom = Math.max(line.bottom, rect.bottom);
      } else {
        lines.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
      }
    }
    for (const line of lines) {
      boxes.push({
        left: line.left,
        top: line.top,
        width: line.right - line.left,
        height: line.bottom - line.top,
      });
    }
  }
  return boxes;
}

function sameOutlineRects(a: HighlightOutlineRect[], b: HighlightOutlineRect[]) {
  return (
    a.length === b.length &&
    a.every(
      (box, index) =>
        box.left === b[index].left &&
        box.top === b[index].top &&
        box.width === b[index].width &&
        box.height === b[index].height,
    )
  );
}

/** Where the action bar sits for a selection rect: just under it, clamped to
 * the viewport with `reservedWidth` room for the buttons before the right
 * edge (wider when an Expand button joins Remove and Ask). */
function highlightActionPlacement(rect: DOMRect, reservedWidth = 260) {
  return {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - reservedWidth)),
    top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 35)),
    offscreen: rect.bottom < 0 || rect.top > window.innerHeight,
  };
}

function sameCardTops(a: Record<string, number>, b: Record<string, number>) {
  const aKeys = Object.keys(a);
  return (
    aKeys.length === Object.keys(b).length &&
    aKeys.every((key) => a[key] === b[key])
  );
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
  onUpdateDocument,
  onCancel,
  onOpenPane,
  linkActions,
  onError,
  onToast,
  onPublish,
  publicationBinding,
  onPublicationBindingChange,
}: ResearchDocumentProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Browser-style visit history for the header's back/forward controls, reset
  // per tree. Transitions live in ../../lib/researchHistory.
  const [history, setHistory] = useState(EMPTY_RESEARCH_HISTORY);
  const [content, setContent] = useState<ResearchNodeContent | null>(null);
  const [followup, setFollowup] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [followupMenu, setFollowupMenu] = useState<FollowupMenu | null>(null);
  const [deletingBranchId, setDeletingBranchId] = useState<string | null>(null);
  const [removingBranch, setRemovingBranch] = useState(false);
  const [documentEditSession, setDocumentEditSession] = useState<DocumentEditSession | null>(null);
  const [branchRemovalError, setBranchRemovalError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentLoadNonce, setContentLoadNonce] = useState(0);
  const [showAllTurns, setShowAllTurns] = useState(false);
  const [showFullTrace, setShowFullTrace] = useState(false);
  const [highlightAction, setHighlightAction] = useState<HighlightAction | null>(null);
  const [savingHighlight, setSavingHighlight] = useState(false);
  // Saved highlights whose anchors no longer locate a passage in the current
  // rendered projection (collapsed transcript content, an edited document).
  // They still exist — surfaced in the footer instead of vanishing silently.
  const [hiddenHighlightCount, setHiddenHighlightCount] = useState(0);
  // The anchored follow-up currently hover-linked to its passage, from either
  // side: hovering the card brightens the passage, hovering the passage
  // raises the card. One state serves both directions.
  const [linkedAnchorNodeId, setLinkedAnchorNodeId] = useState<string | null>(null);
  // Ask mode: the selection anchor a targeted follow-up is being composed
  // against. While set, the composer sits beside the quoted passage.
  const [askAnchor, setAskAnchor] = useState<ResearchHighlightAnchor | null>(null);
  // Desired vertical offsets (px, relative to the follow-ups rail) for child
  // nodes whose query anchor still locates a passage in the rendered response:
  // each card wants its top beside its passage. Membership in this map is what
  // marks a card as anchored.
  const [anchoredCardTops, setAnchoredCardTops] = useState<Record<string, number>>({});
  // Collision-resolved placements derived from the desired tops and the
  // rendered card heights: cards keep their passage alignment when there is
  // room and cascade downward when anchors crowd together.
  const [resolvedCardTops, setResolvedCardTops] = useState<Record<string, number>>({});
  const [highlightDomNonce, setHighlightDomNonce] = useState(0);
  const [metadataNow, setMetadataNow] = useState(() => Date.now());
  const [publicationProposals, setPublicationProposals] = useState<PublicationProposal[]>([]);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [proposalActionId, setProposalActionId] = useState<number | null>(null);
  const [proposalRetryNodeIds, setProposalRetryNodeIds] = useState<Record<number, string>>({});
  const treeId = detail?.tree.id ?? null;
  const documentScrollRef = useRef<HTMLElement | null>(null);
  const followupTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const followupsAsideRef = useRef<HTMLElement | null>(null);
  const followupComposerRef = useRef<HTMLDivElement | null>(null);
  const followupCardsRef = useRef<HTMLDivElement | null>(null);
  const followupMenuRef = useRef<HTMLDivElement | null>(null);
  const responseContentRootRef = useRef<HTMLDivElement | null>(null);
  const resolvedHighlightsRef = useRef<ResolvedHighlight[]>([]);
  // Flat-offset ranges of the query-anchor passages that resolved, refreshed
  // by the anchor paint effect. Consulted by pointer hit-testing (passage-side
  // hover linking) and by the link paint effect.
  const anchoredRangeOffsetsRef = useRef<{ id: string; start: number; end: number }[]>([]);
  const anchorHoverFrameRef = useRef<number | null>(null);
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

  const refreshPublicationProposals = useCallback(async () => {
    const publicationId = publicationBinding?.publicationId;
    if (!publicationId) {
      setPublicationProposals([]);
      setProposalError(null);
      return;
    }
    try {
      const proposals = await listPublicationProposals(publicationId);
      setPublicationProposals(proposals);
      setProposalError(null);
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : String(error));
    }
  }, [publicationBinding?.publicationId]);

  useEffect(() => {
    void refreshPublicationProposals();
  }, [refreshPublicationProposals, publicationBinding?.updatedAt]);

  // A selection anchor belongs to one rendered projection. Navigation or a
  // transcript-visibility change invalidates its offsets, so never leave an
  // action from the previous view floating over the next one.
  useEffect(() => {
    setHighlightAction(null);
    setAskAnchor(null);
    setLinkedAnchorNodeId(null);
    window.getSelection()?.removeAllRanges();
  }, [treeId, selectedNodeId, content?.responseRevision, showAllTurns, showFullTrace]);

  // Restore a persisted in-progress ask once its node's content is on screen.
  // Declared after the reset above so that when both fire in the same pass
  // (the revision landing after a remount), the restore wins.
  useEffect(() => {
    if (!treeId || !selectedNodeId || !content?.responseRevision) {
      return;
    }
    const saved = navigationRef.current[treeId]?.askByNode?.[selectedNodeId];
    if (!saved) {
      return;
    }
    setAskAnchor(saved.anchor);
    // Never clobber text the user managed to type before the content loaded.
    if (saved.text) {
      setFollowup((current) => current || saved.text);
    }
  }, [treeId, selectedNodeId, content?.responseRevision]);

  // Match the right-pane composer: fit the textarea to its contents up to the
  // shared cap, then let it scroll. The node dependency also sizes a newly
  // mounted empty composer after its content finishes loading.
  useEffect(() => {
    const textarea = followupTextareaRef.current;
    if (textarea) {
      growComposerTextarea(textarea);
    }
  }, [followup, content?.node.id]);

  // Event-driven node metadata; fresher than content.node for anything that
  // does not require reparsing the transcript (status, checkpoint, children).
  const selectedDetailNode = useMemo(
    () => detail?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [detail, selectedNodeId],
  );
  // Highlight mutations are announced as research events but do not replace
  // the response snapshot. Mirror their refreshed node metadata into the
  // loaded content so another window's changes reach both the document and a
  // subsequently opened edit warning.
  useEffect(() => {
    if (!selectedDetailNode) {
      return;
    }
    setContent((current) =>
      current?.node.id === selectedDetailNode.id
        ? {
            ...current,
            node: {
              ...current.node,
              highlights: selectedDetailNode.highlights,
            },
          }
        : current,
    );
  }, [selectedDetailNode]);
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
  const anchoredChildren = useMemo(
    () => childNodes.filter((node) => node.queryAnchor),
    [childNodes],
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
      const target = event.target as Node;
      // Leave trigger clicks to the trigger's own handler: closing here on
      // mousedown would clear the state its click-time toggle checks, so the
      // ensuing click always reopens and the trigger can never dismiss.
      if (
        target instanceof Element &&
        target.closest("[data-research-answer-menu-trigger]")
      ) {
        return;
      }
      if (!followupMenuRef.current?.contains(target)) {
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
    const currentDetail = detailRef.current;
    const node = currentDetail?.nodes.find((candidate) => candidate.id === nodeId);
    const menuHeight =
      node?.kind === "document" && node.id === currentDetail?.tree.rootNodeId
        ? DOCUMENT_MENU_HEIGHT
        : FOLLOWUP_MENU_HEIGHT;
    setFollowupMenu({
      nodeId,
      left: Math.max(
        FOLLOWUP_MENU_MARGIN,
        Math.min(clientX, window.innerWidth - FOLLOWUP_MENU_WIDTH - FOLLOWUP_MENU_MARGIN),
      ),
      top: Math.max(
        FOLLOWUP_MENU_MARGIN,
        Math.min(clientY, window.innerHeight - menuHeight - FOLLOWUP_MENU_MARGIN),
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

  function openResearchPublisher(mode: "answer" | "tree", node: ResearchNode) {
    const detailSnapshot = detailRef.current;
    if (!detailSnapshot) {
      return;
    }
    const terminalNodes = detailSnapshot.nodes.filter((candidate) =>
      isTerminalResearchStatus(candidate.status),
    );
    const nodes = mode === "answer" ? [node] : terminalNodes;
    const preview =
      mode === "answer"
        ? content?.node.id === node.id
          ? rawAnswer
          : node.responsePreview?.trim() || researchNodeDisplayTitle(node, detailSnapshot)
        : researchTreePreview(detailSnapshot, terminalNodes);
    const existingBinding =
      mode === "tree" && publicationBinding?.source.kind === "researchTree"
        ? publicationBinding
        : null;
    setFollowupMenu(null);
    onPublish({
      kindLabel: mode === "answer" ? "research answer" : "research tree",
      initialTitle:
        mode === "answer"
          ? researchNodeDisplayTitle(node, detailSnapshot)
          : detailSnapshot.tree.title,
      previewText: preview,
      binding: existingBinding,
      buildDraft: async (title) => {
        const contents = await mapWithConcurrency(nodes, 4, (candidate) =>
          getResearchNodeContent(candidate.id),
        );
        const latestDetail = await getResearchTree(detailSnapshot.tree.id);
        for (const expectedNode of nodes) {
          const latestNode = latestDetail.nodes.find(
            (candidate) => candidate.id === expectedNode.id,
          );
          if (!latestNode || !researchNodeSnapshotMatches(expectedNode, latestNode)) {
            throw new Error(
              "Research changed while preparing the publication. Review the latest results and publish again.",
            );
          }
        }
        return createResearchPublicationDraft({
          title,
          detail: detailSnapshot,
          selectedNodeId: node.id,
          mode,
          contents,
          publicationId: existingBinding?.publicationId,
          createdAt:
            existingBinding?.publicationCreatedAt ??
            (existingBinding ? new Date(existingBinding.createdAt).toISOString() : undefined),
          updatedAt: existingBinding ? new Date().toISOString() : undefined,
          publicNodeIds: existingBinding?.publicNodeIds,
          contributionsByNodeId: Object.fromEntries(
            Object.values(existingBinding?.proposalStates ?? {})
              .filter(
                (state) =>
                  state.status === "accepted" &&
                  Boolean(state.localNodeId) &&
                  Boolean(state.resolutionCommentId),
              )
              .map((state) => [
                state.localNodeId!,
                {
                  githubLogin: state.authorLogin,
                  proposalCommentId: state.proposalCommentId,
                },
              ]),
          ),
        });
      },
    });
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
        recordResearchScrollPosition(
          navigation,
          selectedNodeId,
          documentScrollRef.current.scrollTop,
        );
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
    const saved = restoreResearchScrollPosition(
      navigationRef.current[treeId],
      content.node.id,
    );
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
        recordResearchScrollPosition(
          navigation,
          currentNodeId,
          documentScrollRef.current.scrollTop,
        );
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
    recordResearchScrollPosition(
      navigation,
      selectedNodeId,
      documentScrollRef.current.scrollTop,
    );
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
  const editableDocumentMarkdown = useMemo(() => {
    if (content?.node.kind !== "document") {
      return null;
    }
    for (const turn of content.turns) {
      for (const block of turn.blocks) {
        if (block.type === "text") {
          return block.text;
        }
      }
    }
    return null;
  }, [content]);
  // Memoized because this component renders several times a second while a run
  // streams (detail replacements, the duration tick, every composer keystroke),
  // and the word scanner walks the entire answer.
  const answerWordCount = useMemo(() => countResearchDocumentWords(rawAnswer), [rawAnswer]);

  // Diagram rendering and other child-owned Markdown controls can replace text
  // nodes without changing the transcript items. Observe those commits so saved
  // ranges are rebuilt against the current rendered projection.
  useEffect(() => {
    const root = responseContentRootRef.current;
    if (
      !root ||
      !content?.responseRevision ||
      !content.node.highlights?.length ||
      !researchHighlightApi() ||
      typeof MutationObserver === "undefined"
    ) {
      return;
    }
    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      if (frame !== null) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setHighlightDomNonce((value) => value + 1);
      });
    });
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [
    content?.node.id,
    content?.node.highlights,
    content?.responseRevision,
    showAllTurns,
    showFullTrace,
    timelineItems,
  ]);

  // Paint saved ranges without rewriting the markdown DOM. Anchors retain an
  // exact quote and nearby context so they can be relocated when transcript
  // visibility changes shift the flat rendered-text offsets.
  useLayoutEffect(() => {
    const root = responseContentRootRef.current;
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_HIGHLIGHT_NAME);
    resolvedHighlightsRef.current = [];
    if (!root || !api || !content?.responseRevision) {
      // Nothing is resolvable here (no content yet, or no Highlight API at
      // all) — that is not "hidden highlights", so keep the footer quiet.
      setHiddenHighlightCount(0);
      return;
    }
    const projection = root.textContent ?? "";
    const ranges: Range[] = [];
    for (const highlight of content?.node.highlights ?? []) {
      const offsets = resolveResearchHighlightOffset(
        projection,
        content.responseRevision,
        highlight,
      );
      if (!offsets) {
        continue;
      }
      const range = rangeForTextOffsets(root, offsets.start, offsets.end);
      if (!range) {
        continue;
      }
      ranges.push(range);
      resolvedHighlightsRef.current.push({ highlight, ...offsets });
    }
    if (ranges.length > 0) {
      const painted = new api.Highlight();
      for (const range of ranges) {
        painted.add(range);
      }
      api.registry.set(RESEARCH_HIGHLIGHT_NAME, painted);
    }
    setHiddenHighlightCount(
      (content.node.highlights?.length ?? 0) - resolvedHighlightsRef.current.length,
    );
    return () => {
      api.registry.delete(RESEARCH_HIGHLIGHT_NAME);
    };
  }, [
    content?.node.id,
    content?.node.highlights,
    content?.responseRevision,
    highlightDomNonce,
    showAllTurns,
    showFullTrace,
    timelineItems,
  ]);

  // Paint the passages that targeted follow-ups (and an in-progress ask) were
  // asked about, and resolve each follow-up's rail offset so its card can sit
  // beside its passage. Anchors that no longer locate a passage drop out of
  // the map — their cards fall back to the regular stack.
  useLayoutEffect(() => {
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_QUERY_ANCHOR_NAME);
    const root = responseContentRootRef.current;
    const aside = followupsAsideRef.current;
    const revision = content?.responseRevision;
    const tops: Record<string, number> = {};
    anchoredRangeOffsetsRef.current = [];
    if (root && api && revision) {
      const projection = root.textContent ?? "";
      const asideTop = aside?.getBoundingClientRect().top ?? 0;
      const entries = anchoredChildren.map((node) => ({
        id: node.id,
        anchor: node.queryAnchor!,
      }));
      if (askAnchor) {
        entries.push({ id: "__ask__", anchor: askAnchor });
      }
      const ranges: Range[] = [];
      for (const { id, anchor } of entries) {
        const offsets = resolveResearchHighlightOffset(projection, revision, {
          id,
          anchor,
          createdAt: 0,
        });
        const range = offsets
          ? rangeForTextOffsets(root, offsets.start, offsets.end)
          : null;
        if (!range) {
          continue;
        }
        ranges.push(range);
        if (id !== "__ask__") {
          anchoredRangeOffsetsRef.current.push({ id, ...offsets! });
          if (aside) {
            tops[id] = Math.max(
              0,
              Math.round(range.getBoundingClientRect().top - asideTop),
            );
          }
        }
      }
      if (ranges.length > 0) {
        const painted = new api.Highlight();
        for (const range of ranges) {
          painted.add(range);
        }
        api.registry.set(RESEARCH_QUERY_ANCHOR_NAME, painted);
      }
    }
    setAnchoredCardTops((current) => (sameCardTops(current, tops) ? current : tops));
    return () => {
      api?.registry.delete(RESEARCH_QUERY_ANCHOR_NAME);
    };
  }, [
    anchoredChildren,
    askAnchor,
    content?.node.id,
    content?.responseRevision,
    highlightDomNonce,
    showAllTurns,
    showFullTrace,
    timelineItems,
  ]);

  // Brighten the hover-linked follow-up's passage. Depends on anchoredCardTops
  // (set in the same commit that refreshes the offsets ref) so a re-resolution
  // repaints the link against current offsets.
  useLayoutEffect(() => {
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_ANCHOR_LINK_NAME);
    const root = responseContentRootRef.current;
    if (!api || !root || !linkedAnchorNodeId) {
      return;
    }
    const entry = anchoredRangeOffsetsRef.current.find(
      (candidate) => candidate.id === linkedAnchorNodeId,
    );
    const range = entry ? rangeForTextOffsets(root, entry.start, entry.end) : null;
    if (!range) {
      return;
    }
    const painted = new api.Highlight();
    painted.add(range);
    api.registry.set(RESEARCH_ANCHOR_LINK_NAME, painted);
    return () => {
      api.registry.delete(RESEARCH_ANCHOR_LINK_NAME);
    };
  }, [anchoredCardTops, highlightDomNonce, linkedAnchorNodeId]);

  // A selection that lands on saved highlights repaints those annotations in
  // the standard selection tone: painted above the saved-highlight layer (via
  // priority) so the olive annotation tone cannot win over the selection,
  // keeping a selected highlight the same color as any other selected text.
  const selectedHighlightKey = (highlightAction?.highlightIds ?? []).join("\n");
  useLayoutEffect(() => {
    const api = researchHighlightApi();
    api?.registry.delete(RESEARCH_SELECTED_NAME);
    const root = responseContentRootRef.current;
    if (!api || !root || !selectedHighlightKey) {
      return;
    }
    const selectedIds = selectedHighlightKey.split("\n");
    const painted = new api.Highlight();
    painted.priority = 1;
    let paintedAny = false;
    for (const { highlight, start, end } of resolvedHighlightsRef.current) {
      if (!selectedIds.includes(highlight.id)) {
        continue;
      }
      const range = rangeForTextOffsets(root, start, end);
      if (!range) {
        continue;
      }
      painted.add(range);
      paintedAny = true;
    }
    if (paintedAny) {
      api.registry.set(RESEARCH_SELECTED_NAME, painted);
    }
    return () => {
      api.registry.delete(RESEARCH_SELECTED_NAME);
    };
  }, [selectedHighlightKey, highlightDomNonce]);

  // One-pass collision resolution for anchored cards: place them in
  // desired-top order, each no higher than the previous card's bottom plus a
  // gap. Runs as a layout effect in the commit that rendered the cards, so
  // their heights are measurable and the corrected placements land before
  // paint. Heights depend only on card content — never on the tops this
  // effect assigns — so a single pass settles the layout without feedback.
  useLayoutEffect(() => {
    const aside = followupsAsideRef.current;
    const next: Record<string, number> = {};
    if (aside) {
      const heights = new Map<string, number>();
      for (const element of aside.querySelectorAll<HTMLElement>(
        ".research-followup-card.is-anchored",
      )) {
        if (element.dataset.nodeId) {
          heights.set(element.dataset.nodeId, element.offsetHeight);
        }
      }
      let cursor = Number.NEGATIVE_INFINITY;
      const placements = Object.entries(anchoredCardTops).sort(
        // Ties break on node id so equal desired tops keep a stable order.
        (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
      );
      for (const [nodeId, desiredTop] of placements) {
        const top = Math.max(desiredTop, cursor);
        next[nodeId] = top;
        cursor = top + (heights.get(nodeId) ?? 0) + ANCHORED_CARD_GAP;
      }
    }
    setResolvedCardTops((current) => (sameCardTops(current, next) ? current : next));
    // childNodes remeasures when streaming previews change card heights.
  }, [anchoredCardTops, childNodes]);

  // Ask mode's slide: translate the composer down beside the quoted passage
  // and push any cards it would cover out of the way. Transforms keep the
  // rail's flow layout untouched, so clearing them animates everything home.
  useLayoutEffect(() => {
    const composer = followupComposerRef.current;
    const aside = followupsAsideRef.current;
    const clear = () => {
      if (composer) {
        composer.style.transform = "";
      }
      if (aside) {
        for (const element of aside.querySelectorAll<HTMLElement>(
          ".research-followup-cards > .research-followup-card, .research-followup-card.is-anchored",
        )) {
          element.style.transform = "";
        }
      }
    };
    const root = responseContentRootRef.current;
    const revision = content?.responseRevision;
    if (!askAnchor || !composer || !aside || !root || !revision) {
      clear();
      return;
    }
    const projection = root.textContent ?? "";
    const offsets = resolveResearchHighlightOffset(projection, revision, {
      id: "__ask__",
      anchor: askAnchor,
      createdAt: 0,
    });
    const range = offsets
      ? rangeForTextOffsets(root, offsets.start, offsets.end)
      : null;
    if (!range) {
      clear();
      return;
    }
    const asideTop = aside.getBoundingClientRect().top;
    const targetTop = Math.max(
      0,
      Math.round(range.getBoundingClientRect().top - asideTop),
    );
    composer.style.transform = `translateY(${Math.max(0, targetTop - composer.offsetTop)}px)`;
    const clearanceBottom = targetTop + composer.offsetHeight + ASK_COMPOSER_CLEARANCE;
    const cards = followupCardsRef.current;
    if (cards) {
      // The stack keeps its internal spacing: the first card the composer
      // would cover sets one shared shift for itself and everything after it.
      let delta = 0;
      for (const element of Array.from(cards.children) as HTMLElement[]) {
        if (delta === 0 && element.offsetTop + element.offsetHeight > targetTop) {
          delta = Math.max(0, clearanceBottom - element.offsetTop);
        }
        element.style.transform = delta > 0 ? `translateY(${delta}px)` : "";
      }
    }
    for (const element of aside.querySelectorAll<HTMLElement>(
      ".research-followup-card.is-anchored",
    )) {
      const overlaps =
        element.offsetTop < clearanceBottom &&
        element.offsetTop + element.offsetHeight > targetTop;
      element.style.transform = overlaps
        ? `translateY(${clearanceBottom - element.offsetTop}px)`
        : "";
    }
    return clear;
  }, [
    anchoredCardTops,
    askAnchor,
    childNodes,
    content?.responseRevision,
    followup,
    highlightDomNonce,
    resolvedCardTops,
  ]);

  const captureHighlightSelection = useCallback(() => {
    const root = responseContentRootRef.current;
    const revision = content?.responseRevision;
    const selection = window.getSelection();
    if (
      !root ||
      !revision ||
      !researchHighlightApi() ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0
    ) {
      setHighlightAction(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const offsets = selectionOffsets(root, range);
    if (!offsets) {
      setHighlightAction(null);
      return;
    }
    const projection = root.textContent ?? "";
    const exact = projection.slice(offsets.start, offsets.end);
    const resolvedRanges = resolvedHighlightsRef.current.map(
      ({ highlight, start, end }) => ({
        id: highlight.id,
        start,
        end,
      }),
    );
    const highlightIds = intersectingResearchHighlightIds(offsets, resolvedRanges);
    // Whitespace cannot form a useful new highlight, but it can still be a
    // selected subset of an existing annotation that the user wants removed.
    if (!exact.trim() && highlightIds.length === 0) {
      setHighlightAction(null);
      return;
    }
    const anchorForOffsets = (span: {
      start: number;
      end: number;
    }): ResearchHighlightAnchor => ({
      version: 1,
      projection: "answer-v1",
      responseRevision: revision,
      start: span.start,
      end: span.end,
      exact: projection.slice(span.start, span.end),
      prefix: textContextSlice(
        projection,
        Math.max(0, span.start - RESEARCH_HIGHLIGHT_CONTEXT_LENGTH),
        span.start,
      ),
      suffix: textContextSlice(
        projection,
        span.end,
        span.end + RESEARCH_HIGHLIGHT_CONTEXT_LENGTH,
      ),
    });
    const expandOffsets = expandedResearchHighlightOffsets(offsets, resolvedRanges);
    const rect = range.getBoundingClientRect();
    setHighlightAction({
      anchor: anchorForOffsets(offsets),
      highlightIds,
      expandAnchor: expandOffsets ? anchorForOffsets(expandOffsets) : null,
      outlineRects: highlightOutlineRects(root, resolvedHighlightsRef.current, highlightIds),
      ...highlightActionPlacement(rect, expandOffsets ? 340 : 260),
    });
  }, [content?.responseRevision]);

  // A plain click on a painted highlight selects the whole annotation, which
  // reopens the action bar (Remove / Ask) through the ordinary selection flow.
  // Runs on click, after the mouseup capture has already dismissed the bar for
  // a collapsed selection; CSS highlights have no DOM nodes, so the click is
  // hit-tested against the resolved flat-offset ranges.
  const selectHighlightAtPoint = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const root = responseContentRootRef.current;
      const selection = window.getSelection();
      if (!root || !selection || !selection.isCollapsed) {
        return;
      }
      // Links keep their own click behavior; popping the bar under a
      // navigation would be noise.
      if (event.target instanceof Element && event.target.closest("a")) {
        return;
      }
      const offset = flatOffsetAtPoint(root, event.clientX, event.clientY);
      if (offset === null) {
        return;
      }
      const resolved = resolvedHighlightsRef.current.find(
        ({ start, end }) => offset >= start && offset < end,
      );
      if (!resolved) {
        return;
      }
      const range = rangeForTextOffsets(root, resolved.start, resolved.end);
      if (!range) {
        return;
      }
      selection.removeAllRanges();
      selection.addRange(range);
      captureHighlightSelection();
    },
    [captureHighlightSelection],
  );

  // Passage-side hover linking: hit-test the pointer against the resolved
  // query-anchor ranges (rAF-throttled — the walk is cheap but not free) and
  // link the follow-up card whose passage the pointer is over.
  const linkAnchorUnderPointer = useCallback((event: React.MouseEvent) => {
    const { clientX, clientY } = event;
    if (anchorHoverFrameRef.current !== null) {
      return;
    }
    anchorHoverFrameRef.current = window.requestAnimationFrame(() => {
      anchorHoverFrameRef.current = null;
      const root = responseContentRootRef.current;
      if (!root) {
        return;
      }
      const offset =
        anchoredRangeOffsetsRef.current.length > 0
          ? flatOffsetAtPoint(root, clientX, clientY)
          : null;
      const id =
        offset === null
          ? null
          : anchoredRangeOffsetsRef.current.find(
              ({ start, end }) => offset >= start && offset < end,
            )?.id ?? null;
      setLinkedAnchorNodeId((current) => (current === id ? current : id));
    });
  }, []);

  const unlinkAnchorPointer = useCallback(() => {
    if (anchorHoverFrameRef.current !== null) {
      window.cancelAnimationFrame(anchorHoverFrameRef.current);
      anchorHoverFrameRef.current = null;
    }
    setLinkedAnchorNodeId(null);
  }, []);

  const applyHighlightAction = useCallback(async () => {
    if (!highlightAction || !content || savingHighlight) {
      return;
    }
    setSavingHighlight(true);
    try {
      if (highlightAction.highlightIds.length > 0) {
        const removed = await removeResearchHighlights(
          content.node.id,
          highlightAction.highlightIds,
        );
        const removedIds = new Set(removed.map(({ id }) => id));
        setContent((current) =>
          current?.node.id === content.node.id
            ? {
                ...current,
                node: {
                  ...current.node,
                  highlights: (current.node.highlights ?? []).filter(
                    ({ id }) => !removedIds.has(id),
                  ),
                },
              }
            : current,
        );
      } else {
        const created = await createResearchHighlight(content.node.id, highlightAction.anchor);
        setContent((current) =>
          current?.node.id === content.node.id
            ? {
                ...current,
                node: {
                  ...current.node,
                  highlights: [...(current.node.highlights ?? []), created],
                },
              }
            : current,
        );
      }
      window.getSelection()?.removeAllRanges();
      setHighlightAction(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingHighlight(false);
    }
  }, [content, highlightAction, onError, savingHighlight]);

  // Expand: save the merged annotation, then retire the highlights it
  // absorbed. Creation goes first — if removal then fails, the leftover is
  // overlapping highlights, not a lost annotation.
  const applyExpandHighlightAction = useCallback(async () => {
    if (!highlightAction?.expandAnchor || !content || savingHighlight) {
      return;
    }
    setSavingHighlight(true);
    try {
      const created = await createResearchHighlight(
        content.node.id,
        highlightAction.expandAnchor,
      );
      const removed =
        highlightAction.highlightIds.length > 0
          ? await removeResearchHighlights(content.node.id, highlightAction.highlightIds)
          : [];
      const removedIds = new Set(removed.map(({ id }) => id));
      setContent((current) =>
        current?.node.id === content.node.id
          ? {
              ...current,
              node: {
                ...current.node,
                highlights: [
                  ...(current.node.highlights ?? []).filter(
                    ({ id }) => !removedIds.has(id),
                  ),
                  created,
                ],
              },
            }
          : current,
      );
      window.getSelection()?.removeAllRanges();
      setHighlightAction(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingHighlight(false);
    }
  }, [content, highlightAction, onError, savingHighlight]);

  // The selection can back a targeted follow-up only while the composer can
  // actually submit one: the node finished, and the tree accepts branches.
  const canAskSelection = Boolean(
    highlightAction?.anchor.exact.trim() &&
      !archived &&
      followupNode?.status === "complete",
  );

  const enterAskMode = useCallback(() => {
    if (!highlightAction?.anchor.exact.trim() || archived || followupNode?.status !== "complete") {
      return;
    }
    setAskAnchor(highlightAction.anchor);
    setHighlightAction(null);
    window.getSelection()?.removeAllRanges();
    // Focus once the composer has begun its slide so typing can start
    // immediately; focusing does not interrupt the transform transition.
    window.requestAnimationFrame(() => followupTextareaRef.current?.focus());
  }, [archived, followupNode?.status, highlightAction]);

  // Removes the persisted ask for the current node. Called from the explicit
  // exits (submit, Escape, the quote row's X) — the persist effect below never
  // deletes, so a lifecycle reset of `askAnchor` cannot wipe an ask the user
  // still wants back after a remount.
  const clearSavedAsk = useCallback(() => {
    const currentTreeId = treeIdRef.current;
    const nodeId = selectedNodeIdRef.current;
    if (!currentTreeId || !nodeId) {
      return;
    }
    const askByNode = navigationRef.current[currentTreeId]?.askByNode;
    if (askByNode?.[nodeId]) {
      delete askByNode[nodeId];
      saveResearchNavigation();
    }
  }, []);

  const dismissAsk = useCallback(() => {
    setAskAnchor(null);
    clearSavedAsk();
  }, [clearSavedAsk]);

  // Mirror the in-progress ask into the navigation store so tabbing away from
  // the research surface (which unmounts this document) keeps it. The store
  // mutation is immediate; the localStorage write shares the scroll debounce,
  // and the unmount flush picks up anything still pending. The content guard
  // skips the transient render after a node switch, where the old anchor is
  // still committed alongside the new node id — persisting there would file
  // the ask under the wrong node.
  useEffect(() => {
    if (!askAnchor || !treeId || !selectedNodeId || contentNodeIdRef.current !== selectedNodeId) {
      return;
    }
    const navigation = (navigationRef.current[treeId] ??= { scrollByNode: {} });
    (navigation.askByNode ??= {})[selectedNodeId] = {
      anchor: askAnchor,
      text: followup,
      updatedAt: Date.now(),
    };
    if (navigationPersistTimerRef.current !== null) {
      window.clearTimeout(navigationPersistTimerRef.current);
    }
    navigationPersistTimerRef.current = window.setTimeout(() => {
      navigationPersistTimerRef.current = null;
      saveResearchNavigation();
    }, 250);
  }, [askAnchor, followup, selectedNodeId, treeId]);

  // Keyed on the bar's existence, not the action object: repositioning below
  // replaces the object on every scroll frame, and rebinding all of these
  // listeners each frame would be pure churn.
  const hasHighlightAction = Boolean(highlightAction);
  useEffect(() => {
    if (!hasHighlightAction) {
      return;
    }
    const dismiss = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".research-highlight-actions")) {
        setHighlightAction(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHighlightAction(null);
        return;
      }
      if (savingHighlight || isEditableTarget(event.target)) {
        return;
      }
      if (isResearchAskActionShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        enterAskMode();
        return;
      }
      if (isResearchExpandActionShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        void applyExpandHighlightAction();
        return;
      }
      if (!isResearchHighlightActionShortcut(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void applyHighlightAction();
    };
    // The selection stays valid across scrolls and resizes, so follow it
    // instead of dismissing: recompute the bar's placement from the live
    // selection rect (rAF-throttled), and drop the bar only if the selection
    // itself has gone away.
    let repositionFrame: number | null = null;
    const reposition = () => {
      if (repositionFrame !== null) {
        return;
      }
      repositionFrame = window.requestAnimationFrame(() => {
        repositionFrame = null;
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          setHighlightAction(null);
          return;
        }
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        setHighlightAction((current) => {
          if (!current) {
            return current;
          }
          const placement = highlightActionPlacement(
            rect,
            current.expandAnchor ? 340 : 260,
          );
          const root = responseContentRootRef.current;
          const outlineRects =
            root && current.highlightIds.length > 0
              ? highlightOutlineRects(
                  root,
                  resolvedHighlightsRef.current,
                  current.highlightIds,
                )
              : [];
          return current.left !== placement.left ||
            current.top !== placement.top ||
            current.offscreen !== placement.offscreen ||
            !sameOutlineRects(outlineRects, current.outlineRects)
            ? { ...current, ...placement, outlineRects }
            : current;
        });
      });
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      if (repositionFrame !== null) {
        window.cancelAnimationFrame(repositionFrame);
      }
    };
  }, [
    applyExpandHighlightAction,
    applyHighlightAction,
    enterAskMode,
    hasHighlightAction,
    savingHighlight,
  ]);

  // Escape leaves ask mode from anywhere, including inside the composer's
  // textarea, sliding the composer back to its resting position.
  useEffect(() => {
    if (!askAnchor) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        dismissAsk();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [askAnchor, dismissAsk]);

  async function submitFollowup() {
    const prompt = followup.trim();
    const followupNodeIsDocument = followupNode?.kind === "document";
    // Mirrors the submit button's disabled conditions: Cmd+Enter must not
    // reach the backend (and bounce with an error) from a state the button
    // presents as unavailable — a running node already has a session id.
    // Documents never have a session: their follow-ups launch fresh runs.
    if (
      archived ||
      !followupNode ||
      !prompt ||
      submitting ||
      followupNode.status !== "complete" ||
      (!followupNodeIsDocument && !followupNode.nativeSessionId)
    ) {
      return;
    }
    setSubmitting(true);
    try {
      // The new child lands in the tree detail (refreshed by the fork flow),
      // which is where the follow-up cards render from. Submitting keeps the
      // current node selected rather than following the child to its own page:
      // the reader stays with the answer they asked about, and the new
      // follow-up appears as a card below the composer to open when ready.
      await onFork(followupNode.id, prompt, null, askAnchor);
      setFollowup("");
      setAskAnchor(null);
      clearSavedAsk();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function resolveProposal(
    proposal: PublicationProposal,
    status: "accepted" | "declined",
  ) {
    const binding = publicationBinding;
    if (!binding || proposalActionId !== null) {
      return;
    }
    if (status === "accepted" && (!proposal.parentNodeId || archived)) {
      setProposalError(
        archived
          ? "Restore this research before accepting contributed follow-ups."
          : "This proposal targets a result that is no longer available locally.",
      );
      return;
    }
    setProposalActionId(proposal.commentId);
    setProposalError(null);
    try {
      let localNodeId: string | null = null;
      if (status === "accepted") {
        localNodeId =
          proposal.localNodeId ??
          proposalRetryNodeIds[proposal.commentId] ??
          null;
        if (!localNodeId) {
          const child = await onFork(
            proposal.parentNodeId!,
            proposal.prompt,
            {
              publicationId: binding.publicationId,
              commentId: proposal.commentId,
            },
          );
          localNodeId = child.id;
          setProposalRetryNodeIds((current) => ({
            ...current,
            [proposal.commentId]: child.id,
          }));
        }
      }
      const nextBinding = await resolvePublicationProposal({
        publicationId: binding.publicationId,
        proposalCommentId: proposal.commentId,
        status,
        localNodeId,
      });
      onPublicationBindingChange(nextBinding);
      setProposalRetryNodeIds((current) => {
        const next = { ...current };
        delete next[proposal.commentId];
        return next;
      });
      await refreshPublicationProposals();
      onToast(status === "accepted" ? "Proposal accepted" : "Proposal declined");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProposalError(message);
      onError(message);
    } finally {
      setProposalActionId(null);
    }
  }

  // Prefer the event-driven node over the last content fetch for metadata:
  // detail updates arrive without reparsing the transcript. The chrome
  // (breadcrumb, prompt, follow-ups) renders from this alone, so switching
  // nodes no longer blanks the whole document while content loads — only the
  // response section waits for the fetch.
  const displayNode = selectedDetailNode ?? content?.node ?? null;
  const displayPublicNodeId = displayNode
    ? publicationBinding?.publicNodeIds[displayNode.id] ?? null
    : null;
  const visiblePublicationProposals = publicationProposals.filter(
    (proposal) =>
      proposal.parentNodeId === displayNode?.id ||
      proposal.parentPublicNodeId === displayPublicNodeId,
  );

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

  async function saveDocumentEdit(input: { markdown: string; title: string | null }) {
    if (!documentEditSession) {
      throw new Error("The document is not available for editing.");
    }
    const result = await onUpdateDocument({
      nodeId: documentEditSession.nodeId,
      markdown: input.markdown,
      title: input.title,
      expectedResponseRevision: documentEditSession.responseRevision,
      expectedTitle: documentEditSession.title,
      expectedHighlightIds: documentEditSession.highlightIds,
    });
    if (treeIdRef.current === result.tree.id && result.markdownChanged) {
      // Do not leave the old revision visible after the modal closes. The
      // existing loader refetches the atomically replaced snapshot.
      setContent(null);
      setContentError(null);
      setContentLoadNonce((value) => value + 1);
    }
    if (result.removedHighlightCount > 0) {
      onToast(
        `Document updated · ${result.removedHighlightCount.toLocaleString()} highlight${
          result.removedHighlightCount === 1 ? "" : "s"
        } removed`,
      );
    } else {
      onToast("Document updated");
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
                className="control-button research-history-button"
                disabled
                aria-label="Back"
              >
                <ArrowLeft size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="control-button research-history-button"
                disabled
                aria-label="Forward"
              >
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="research-breadcrumb" aria-label="Research path">
              <span>
                <button className="control-button" type="button" disabled>
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
                  <button className="control-button" type="button" onClick={retry}>
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
  // A document node is authored content, not a run: no prompt to show above
  // the body, and no session checkpoint — its follow-ups launch fresh runs
  // that carry the document as context instead of forking. Everything else —
  // the snapshot-backed timeline, word count, copy, highlights, the follow-up
  // rail — behaves identically.
  const isDocument = displayNode.kind === "document";
  const awaitingCheckpoint =
    !isDocument && displayNode.status === "complete" && !displayNode.nativeSessionId;

  // One renderer for both placements: cards whose query anchor resolved sit
  // absolutely beside their passage; everything else stacks in flow. A card
  // with an anchor that no longer resolves keeps its quote but rejoins the
  // stack.
  const renderFollowupCard = (child: ResearchNode, anchoredTop?: number) => (
    <button
      key={child.id}
      type="button"
      className={`control-button research-followup-card${
        anchoredTop !== undefined ? " is-anchored" : ""
      }${linkedAnchorNodeId === child.id ? " is-anchor-linked" : ""}`}
      style={anchoredTop !== undefined ? { top: anchoredTop } : undefined}
      data-node-id={child.id}
      onClick={() => selectNode(child.id)}
      onMouseEnter={child.queryAnchor ? () => setLinkedAnchorNodeId(child.id) : undefined}
      onMouseLeave={
        child.queryAnchor
          ? () =>
              setLinkedAnchorNodeId((current) => (current === child.id ? null : current))
          : undefined
      }
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openFollowupMenu(child.id, event.clientX, event.clientY);
      }}
    >
      {child.queryAnchor ? (
        <span className="research-followup-quote">
          {quoteDisplayText(child.queryAnchor.exact)}
        </span>
      ) : null}
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
  );
  const stackedChildren = childNodes.filter(
    (child) => anchoredCardTops[child.id] === undefined,
  );

  return (
    <TranscriptLinkActionsProvider actions={linkActions}>
      <>
        <div className="research-workspace">
        <main className="research-document">
          <header className="research-document-header">
            <div className="research-history-nav" aria-label="Research history">
              <button
                type="button"
                className="control-button research-history-button"
                disabled={!canGoBack}
                title={`Back (${IS_MAC ? "⌘[" : "Ctrl+["})`}
                aria-label="Back"
                onClick={goBack}
              >
                <ArrowLeft size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="control-button research-history-button"
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
                  <button className="control-button" type="button" onClick={() => selectNode(node.id)}>
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
                className={`control-button research-trace-toggle${showFullTrace ? " is-active" : ""}`}
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
                className="control-button research-open-terminal"
                onClick={() => onOpenPane(displayNode.paneId!)}
              >
                <ExternalLink size={14} aria-hidden="true" />
                Open terminal
              </button>
            ) : null}
            {activeRun || cancellationNeedsRetry ? (
              <button
                type="button"
                className="control-button research-cancel-run"
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

          <DomSearchBar
            active
            placeholder="Find in research"
            rootRef={documentScrollRef}
          />

          <article
            ref={documentScrollRef}
            className="research-document-scroll"
            onScroll={recordScroll}
          >
            <div className="research-document-content">
              {!isDocument ? (
                <div className="research-prompt">
                  {displayNode.parentNodeId ? (
                    <button
                      type="button"
                      className="control-button research-parent-link"
                      onClick={() => selectNode(displayNode.parentNodeId!)}
                    >
                      <ArrowLeft size={13} aria-hidden="true" />
                      Back
                    </button>
                  ) : null}
                  {displayNode.queryAnchor ? (
                    <blockquote className="research-prompt-quote">
                      {quoteDisplayText(displayNode.queryAnchor.exact)}
                    </blockquote>
                  ) : null}
                  <TranscriptMarkdown text={displayNode.prompt} imageBehavior="open" inline />
                </div>
              ) : null}
              <div className="research-response-grid">
                <section className="research-response" aria-label="Research response">
                  {!content ? (
                    <div className="research-response-loading">
                      {contentError ? (
                        <>
                          <p role="alert">{contentError}</p>
                          <button className="control-button"
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
                      <button className="control-button"
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
                                  : "Working..."
                                : "No response is available."}
                    </p>
                  ) : (
                    <>
                      {hiddenTimelineItemCount > 0 ? (
                        <button
                          type="button"
                          className="control-button research-show-earlier"
                          onClick={expandAllTurns}
                        >
                          Show {hiddenTimelineItemCount} earlier response item
                          {hiddenTimelineItemCount === 1 ? "" : "s"}
                        </button>
                      ) : null}
                      <div
                        ref={responseContentRootRef}
                        className="research-response-content-root"
                        onMouseUp={captureHighlightSelection}
                        onKeyUp={captureHighlightSelection}
                        onClick={selectHighlightAtPoint}
                        onMouseMove={linkAnchorUnderPointer}
                        onMouseLeave={unlinkAnchorPointer}
                      >
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
                      {hiddenHighlightCount > 0 ? (
                        <span
                          className="research-hidden-highlights"
                          title="These saved highlights couldn't be located in the current view. Their passages may sit in content that isn't rendered right now."
                        >
                          {hiddenHighlightCount}{" "}
                          {hiddenHighlightCount === 1 ? "highlight" : "highlights"} not
                          visible in this view
                          {hasTranscriptActivity && !showFullTrace ? (
                            <>
                              {" · "}
                              <button
                                type="button"
                                className="control-button research-hidden-highlights-reveal"
                                onClick={() => setShowFullTrace(true)}
                              >
                                Show full transcript
                              </button>
                            </>
                          ) : null}
                        </span>
                      ) : null}
                      {displayNode.status === "complete" && rawAnswer ? (
                        <button
                          type="button"
                          className="control-button research-answer-copy"
                          title="Copy answer as Markdown"
                          aria-label="Copy answer as Markdown"
                          onClick={() => void copyAnswer()}
                        >
                          <Copy size={14} aria-hidden="true" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="control-button research-answer-menu-trigger"
                        title="Answer actions"
                        aria-label="Answer actions"
                        aria-haspopup="menu"
                        aria-expanded={followupMenu?.nodeId === displayNode.id}
                        data-research-answer-menu-trigger
                        onClick={(event) => openAnswerMenu(event.currentTarget, displayNode.id)}
                      >
                        <MoreHorizontal size={15} aria-hidden="true" />
                      </button>
                    </footer>
                  ) : null}
                </section>

                <aside
                  ref={followupsAsideRef}
                  className="research-followups"
                  aria-label="Follow-ups"
                >
                  <div
                    ref={followupComposerRef}
                    className={`research-followup-composer${
                      archived || displayNode.status !== "complete" ? " is-disabled" : ""
                    }${askAnchor ? " is-anchored" : ""}`}
                  >
                    {askAnchor ? (
                      <div className="research-followup-quote-row">
                        <span className="research-followup-quote">
                          {quoteDisplayText(askAnchor.exact)}
                        </span>
                        <button
                          type="button"
                          className="control-button research-followup-quote-dismiss"
                          aria-label="Cancel the targeted question"
                          title="Cancel (Esc)"
                          onClick={dismissAsk}
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </div>
                    ) : null}
                    {/* Reserved for later use: the follow-up mode toggle that
                        offered plain "Ask about" vs "Deep research" follow-ups.
                        Re-enabling it needs the `followupMode` state and the
                        submit-time deep-research command prefix in
                        `submitFollowup` (both in git history).
                    <div
                      className="sidebar-mode-toggle research-followup-mode-toggle"
                      role="tablist"
                      aria-label="Follow-up mode"
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={followupMode === "ask"}
                        className={`control-button${followupMode === "ask" ? " is-selected" : ""}`}
                        disabled={archived || displayNode.status !== "complete"}
                        onClick={() => setFollowupMode("ask")}
                      >
                        <span>Ask about</span>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={followupMode === "deep"}
                        className={`control-button${followupMode === "deep" ? " is-selected" : ""}`}
                        disabled={archived || displayNode.status !== "complete"}
                        onClick={() => setFollowupMode("deep")}
                      >
                        <span>Deep research</span>
                      </button>
                    </div>
                    */}
                    <textarea
                      ref={followupTextareaRef}
                      value={followup}
                      placeholder={
                        askAnchor
                          ? "Ask about the highlighted text…"
                          : isDocument
                            ? "Ask about this document…"
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
                      <button className="control-button"
                        type="button"
                        disabled={
                          archived ||
                          !followup.trim() ||
                          submitting ||
                          displayNode.status !== "complete" ||
                          awaitingCheckpoint
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
                    {!archived && awaitingCheckpoint ? (
                      <small>Waiting for the native session checkpoint before branching.</small>
                    ) : null}
                  </div>
                  <div ref={followupCardsRef} className="research-followup-cards">
                    {stackedChildren.map((child) => renderFollowupCard(child))}
                  </div>
                  {childNodes
                    .filter((child) => anchoredCardTops[child.id] !== undefined)
                    .map((child) => ({
                      child,
                      // The measuring pass has not seen a brand-new card yet;
                      // its desired top stands in until resolution lands
                      // (within the same pre-paint commit cycle).
                      top: resolvedCardTops[child.id] ?? anchoredCardTops[child.id],
                    }))
                    .sort((a, b) => a.top - b.top)
                    .map(({ child, top }) => renderFollowupCard(child, top))}
                  {publicationBinding &&
                  (visiblePublicationProposals.length > 0 || proposalError) ? (
                    <section
                      className="research-publication-proposals"
                      aria-labelledby="research-publication-proposals-title"
                    >
                      <div className="research-publication-proposals-heading">
                        <h3 id="research-publication-proposals-title">
                          Community proposals
                        </h3>
                        <button
                          type="button"
                          className="control-button"
                          aria-label="Refresh community proposals"
                          title="Refresh"
                          disabled={proposalActionId !== null}
                          onClick={() => void refreshPublicationProposals()}
                        >
                          <RefreshCw size={13} aria-hidden="true" />
                        </button>
                      </div>
                      {proposalError ? (
                        <p className="research-publication-proposal-error" role="alert">
                          {proposalError}
                        </p>
                      ) : null}
                      {visiblePublicationProposals.map((proposal) => (
                        <article
                          className="research-publication-proposal"
                          key={proposal.commentId}
                        >
                          <header>
                            <strong>@{proposal.authorLogin}</strong>
                            <span className={`is-${proposal.status}`}>
                              {proposal.status}
                            </span>
                          </header>
                          <TranscriptMarkdown
                            text={proposal.prompt}
                            imageBehavior="open"
                            inline
                          />
                          {proposal.answerMarkdown ? (
                            <details>
                              <summary>Proposed answer</summary>
                              <TranscriptMarkdown
                                text={proposal.answerMarkdown}
                                imageBehavior="open"
                              />
                            </details>
                          ) : null}
                          {proposal.status === "pending" ? (
                            <div className="research-publication-proposal-actions">
                              <button
                                type="button"
                                className="control-button"
                                disabled={
                                  proposalActionId !== null ||
                                  archived ||
                                  !proposal.parentNodeId
                                }
                                onClick={() => void resolveProposal(proposal, "accepted")}
                              >
                                {proposalActionId === proposal.commentId ? (
                                  <LoaderCircle
                                    className="research-spinner"
                                    size={13}
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Check size={13} aria-hidden="true" />
                                )}
                                {proposal.localNodeId ? "Finish acceptance" : "Accept"}
                              </button>
                              <button
                                type="button"
                                className="control-button"
                                disabled={
                                  proposalActionId !== null ||
                                  Boolean(proposal.localNodeId)
                                }
                                onClick={() => void resolveProposal(proposal, "declined")}
                              >
                                <X size={13} aria-hidden="true" />
                                Decline
                              </button>
                            </div>
                          ) : proposal.localNodeId &&
                            detail.nodes.some((node) => node.id === proposal.localNodeId) ? (
                            <button
                              type="button"
                              className="control-button research-publication-proposal-result"
                              onClick={() => selectNode(proposal.localNodeId!)}
                            >
                              Open local result
                            </button>
                          ) : null}
                        </article>
                      ))}
                    </section>
                  ) : null}
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
              // A document root has no prompt; its identity is the tree title.
              const nodeName = (node.title ?? node.prompt) || detail.tree.title;
              return createPortal(
                <div
                  ref={followupMenuRef}
                  className="popover-surface popover-surface--context pane-context-menu research-followup-menu"
                  role="menu"
                  aria-label={`Actions for ${nodeName}`}
                  style={{ left: followupMenu.left, top: followupMenu.top }}
                  onMouseDown={(event) => event.stopPropagation()}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  <div className="group-context-actions">
                    <button
                      type="button"
                      role="menuitem"
                      className="control-button"
                      disabled={!isTerminalResearchStatus(node.status)}
                      title={
                        isTerminalResearchStatus(node.status)
                          ? undefined
                          : "This result must finish before it can be published"
                      }
                      onClick={() => openResearchPublisher("answer", node)}
                    >
                      <Share2 size={13} aria-hidden="true" />
                      <span>Publish answer</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="control-button"
                      disabled={
                        !detail.nodes.some(
                          (candidate) =>
                            candidate.id === detail.tree.rootNodeId &&
                            isTerminalResearchStatus(candidate.status),
                        )
                      }
                      title={
                        detail.nodes.some(
                          (candidate) =>
                            candidate.id === detail.tree.rootNodeId &&
                            isTerminalResearchStatus(candidate.status),
                        )
                          ? undefined
                          : "The root result must finish before publishing the tree"
                      }
                      onClick={() => openResearchPublisher("tree", node)}
                    >
                      <Share2 size={13} aria-hidden="true" />
                      <span>Publish research</span>
                    </button>
                    <div className="context-menu-divider" role="separator" />
                    {rootNode && node.kind === "document" ? (
                      <>
                        <button className="control-button"
                          type="button"
                          role="menuitem"
                          disabled={
                            archived ||
                            content?.node.id !== node.id ||
                            !content?.responseRevision ||
                            editableDocumentMarkdown === null
                          }
                          title={
                            archived
                              ? "Unarchive this research before editing its document"
                              : content?.node.id !== node.id ||
                                  !content?.responseRevision ||
                                  editableDocumentMarkdown === null
                                ? "The document content is unavailable"
                                : undefined
                          }
                          onClick={() => {
                            setFollowupMenu(null);
                            if (content?.responseRevision && editableDocumentMarkdown !== null) {
                              setDocumentEditSession({
                                nodeId: content.node.id,
                                markdown: editableDocumentMarkdown,
                                title: detail.tree.title,
                                responseRevision: content.responseRevision,
                                highlightIds:
                                  content.node.highlights?.map((highlight) => highlight.id) ?? [],
                                highlightCount: content.node.highlights?.length ?? 0,
                              });
                            }
                          }}
                        >
                          <Pencil size={13} aria-hidden="true" />
                          <span>Edit document</span>
                        </button>
                        <div className="context-menu-divider" role="separator" />
                      </>
                    ) : null}
                    <button
                      type="button"
                      role="menuitem"
                      className="control-button context-menu-danger"
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
        {documentEditSession
          ? createPortal(
              <DocumentDialog
                open
                mode="edit"
                initialMarkdown={documentEditSession.markdown}
                initialTitle={documentEditSession.title}
                highlightCount={documentEditSession.highlightCount}
                resetKey={`${documentEditSession.nodeId}:${documentEditSession.responseRevision}`}
                onClose={() => setDocumentEditSession(null)}
                onSubmit={saveDocumentEdit}
              />,
              document.body,
            )
          : null}
        {highlightAction
          ? createPortal(
              <>
                {highlightAction.outlineRects.map((box, index) => (
                  <div
                    key={index}
                    className="research-highlight-selection-outline"
                    style={{
                      left: box.left - 2,
                      top: box.top - 2,
                      width: box.width + 4,
                      height: box.height + 4,
                    }}
                  />
                ))}
                <div
                  className="research-highlight-actions"
                  style={{
                    left: highlightAction.left,
                    top: highlightAction.top,
                    visibility: highlightAction.offscreen ? "hidden" : undefined,
                  }}
                >
                  <button
                    type="button"
                    className="control-button research-highlight-action"
                    disabled={savingHighlight}
                    aria-keyshortcuts="H"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void applyHighlightAction()}
                  >
                    <span>
                      {savingHighlight
                        ? "Saving…"
                        : highlightAction.highlightIds.length > 1
                          ? "Remove highlights"
                          : highlightAction.highlightIds.length === 1
                            ? "Remove highlight"
                            : "Highlight"}
                    </span>
                    <kbd className="context-menu-shortcut is-keycap" aria-hidden="true">
                      H
                    </kbd>
                  </button>
                  {highlightAction.expandAnchor ? (
                    <button
                      type="button"
                      className="control-button research-highlight-action"
                      disabled={savingHighlight}
                      aria-keyshortcuts="E"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void applyExpandHighlightAction()}
                    >
                      <span>
                        {highlightAction.highlightIds.length > 1
                          ? "Merge highlights"
                          : "Expand highlight"}
                      </span>
                      <kbd className="context-menu-shortcut is-keycap" aria-hidden="true">
                        E
                      </kbd>
                    </button>
                  ) : null}
                  {canAskSelection ? (
                    <button
                      type="button"
                      className="control-button research-highlight-action"
                      disabled={savingHighlight}
                      aria-keyshortcuts="A"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={enterAskMode}
                    >
                      <span>Ask</span>
                      <kbd className="context-menu-shortcut is-keycap" aria-hidden="true">
                        A
                      </kbd>
                    </button>
                  ) : null}
                </div>
              </>,
              document.body,
            )
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
                  <p>
                    Delete "
                    {(deletingBranch.node.title ?? deletingBranch.node.prompt) ||
                      detail.tree.title}
                    "?
                  </p>
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
                    <button className="control-button"
                      type="button"
                      disabled={removingBranch}
                      onClick={() => setDeletingBranchId(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="control-button danger"
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

function isTerminalResearchStatus(status: ResearchNode["status"]) {
  return status === "complete" || status === "failed" || status === "cancelled";
}

function researchNodeDisplayTitle(node: ResearchNode, detail: ResearchTreeDetail) {
  if (node.id === detail.tree.rootNodeId) {
    return node.title?.trim() || detail.tree.title;
  }
  return (
    node.title?.trim() ||
    node.prompt.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ||
    "Research follow-up"
  );
}

function researchTreePreview(detail: ResearchTreeDetail, nodes: ResearchNode[]) {
  const lines = [
    detail.tree.title,
    "",
    `${nodes.length} published result${nodes.length === 1 ? "" : "s"}`,
  ];
  for (const node of nodes) {
    lines.push(
      `- ${researchNodeDisplayTitle(node, detail)}${
        node.status === "complete" ? "" : ` (${node.status})`
      }`,
    );
  }
  return lines.join("\n");
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
