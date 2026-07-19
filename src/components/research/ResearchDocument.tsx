import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, Copy, ExternalLink, LoaderCircle, MoreHorizontal, Pencil, RefreshCw, ScrollText, Share2, Terminal, Trash2, Wrench, X } from "lucide-react";
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
import {
  conversationActivityToolCalls,
  conversationToolCallLabel,
} from "../../lib/researchConversations";
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
  formatPlainTextTranscript,
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
import DocumentComposer from "./DocumentComposer";
import { ResearchDocumentFrame, ResearchHistoryNav } from "./ResearchDocumentChrome";

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
// When connector vertical runs would sit on top of one another, they fan out
// into the gutter by one lane's worth per collision. A run may be displaced up
// to this fraction of its own horizontal span from the centered midline.
const CONNECTOR_STAGGER_FRACTION = 0.25;
// Pixel separation between adjacent lanes of overlapping vertical runs. Capped
// per-connector by CONNECTOR_STAGGER_FRACTION.
const CONNECTOR_STAGGER_STEP = 14;

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

// Rows whose text is transcript machinery rather than the assistant's prose:
// tool calls and their payloads, the "Raw" disclosure (also a `.tool-block`,
// and it can nest inside a message), collapsed thinking, and grouped activity.
// Selections that touch any of these carry no meaning worth anchoring, so
// highlight/ask is not offered on them.
const NON_TEXT_ROW_SELECTOR =
  ".tool-block, .thinking-block, .activity-group-block, .research-conversation-activity";

/** True when the range starts, ends, or spans across any non-text row. Because
 * `.tool-block` disclosures can sit inside a `.research-response-message`, this
 * intersection test — not a positive "is inside a message" check — is what
 * keeps highlights confined to prose. */
function selectionTouchesNonTextRow(root: HTMLElement, range: Range) {
  for (const row of root.querySelectorAll(NON_TEXT_ROW_SELECTOR)) {
    if (range.intersectsNode(row)) {
      return true;
    }
  }
  return false;
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

/** Flat-offset span of the `.research-response-message` that encloses the
 * whole selection, or null when the selection is not confined to a single
 * message. A message renders the same text in every transcript view, but the
 * rows around it do not, so anchoring context taken near a message edge is
 * clamped to this span — otherwise a prefix/suffix that reached into an
 * adjacent tool or thinking row would only resolve in the view it was taken
 * in, and the highlight would vanish on toggle. */
function enclosingMessageFlatBounds(root: HTMLElement, range: Range) {
  const messageOf = (node: Node) =>
    (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
      ".research-response-message",
    ) ?? null;
  const message = messageOf(range.startContainer);
  if (!message || message !== messageOf(range.endContainer)) {
    return null;
  }
  const start = flatTextOffsetAt(root, message, 0);
  const end = flatTextOffsetAt(root, message, message.childNodes.length);
  return start !== null && end !== null ? { start, end } : null;
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
  const pixelRatio = window.devicePixelRatio || 1;
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
      // Range geometry can land between device pixels while WebKit rounds the
      // Custom Highlight paint independently. Expand to the enclosing device
      // pixels first so the outline's one-pixel clearance cannot round inward.
      const left = Math.floor(line.left * pixelRatio) / pixelRatio;
      const top = Math.floor(line.top * pixelRatio) / pixelRatio;
      const right = Math.ceil(line.right * pixelRatio) / pixelRatio;
      const bottom = Math.ceil(line.bottom * pixelRatio) / pixelRatio;
      boxes.push({
        left,
        top,
        width: right - left,
        height: bottom - top,
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

// Rounded-elbow connector path: out from the passage's line into the gutter,
// a vertical run at `midX` (defaults to the gutter's midline), then into the
// card at the card's own height. Degenerates to a straight segment when the
// pair is level or the gutter is too tight for the turns.
function connectorElbowPath(
  sx: number,
  sy: number,
  ex: number,
  ey: number,
  midX = Math.round((sx + ex) / 2),
): string {
  const dy = ey - sy;
  if (Math.abs(dy) < 2 || ex - sx < 8) {
    return `M ${sx} ${sy} L ${ex} ${ey}`;
  }
  const r = Math.min(10, Math.abs(dy) / 2, midX - sx, ex - midX);
  const dir = dy > 0 ? 1 : -1;
  return (
    `M ${sx} ${sy} L ${midX - r} ${sy}` +
    ` Q ${midX} ${sy} ${midX} ${sy + dir * r}` +
    ` L ${midX} ${ey - dir * r}` +
    ` Q ${midX} ${ey} ${midX + r} ${ey}` +
    ` L ${ex} ${ey}`
  );
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
      return "Working…";
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

function ResearchMessageBlock({
  block,
  role,
  conversation = false,
}: {
  block: MessageBlock;
  role: string;
  conversation?: boolean;
}) {
  if (block.type === "text") {
    // In a conversation node every turn is first-class content: user
    // messages render as markdown prompts, not as unexpected-content
    // callouts (that framing exists for run responses, where a mid-response
    // user turn signals leakage).
    if (role === "assistant" || conversation) {
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
const ResearchTimelineItem = memo(function ResearchTimelineItem({
  item,
  conversation = false,
}: {
  item: MessageItem;
  conversation?: boolean;
}) {
  if (conversation) {
    return (
      <section
        className={`research-response-item role-${item.role} is-conversation`}
        data-timeline-key={item.key}
      >
        {item.blocks.length > 0 ? (
          <div
            className={`research-response-message${
              item.role === "user" ? " research-conversation-prompt" : ""
            }${timelineStatusClass(item.status)}`}
          >
            {item.blocks.map((block, index) => (
              <ResearchMessageBlock
                key={`${item.key}-${index}`}
                block={block}
                role={item.role}
                conversation
              />
            ))}
          </div>
        ) : null}
        {item.activities.map((activity) => {
          // Export activity markers (collapsed tool calls) render as quiet
          // chips; anything else — impossible in a well-formed export, but
          // archives are only shape-validated — falls back to the ordinary
          // activity disclosure.
          const toolCalls = conversationActivityToolCalls(activity);
          if (toolCalls === null) {
            return (
              <TranscriptActivityItem
                key={activity.key}
                item={activity}
                isRootActivity
                maxPayloadCharacters={ACTIVITY_PAYLOAD_CHAR_LIMIT}
                deferPayloads
                showResultCharacterCount={false}
              />
            );
          }
          // A malformed marker count still renders a chip (labelled without
          // a number): the marker's whole job is preserving the fact that
          // tool activity happened.
          return (
            <div key={activity.key} className="research-conversation-activity">
              <Wrench size={12} aria-hidden="true" />
              <span>{conversationToolCallLabel(toolCalls)}</span>
            </div>
          );
        })}
      </section>
    );
  }
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
  // Dotted elbows between anchored passages and their follow-up cards: SVG
  // paths in response-grid pixel coordinates, plus their passage-end dots.
  const [anchorConnectors, setAnchorConnectors] = useState<{
    id: string;
    d: string;
    x: number;
    y: number;
  }[]>([]);
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
  const [pointerOverHighlight, setPointerOverHighlight] = useState(false);
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
  const responseGridRef = useRef<HTMLDivElement | null>(null);
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

  // The floating action bar caches pixel geometry and a live selection from
  // one rendered projection, so a transcript-visibility change (or navigation)
  // leaves it pointing at content that has moved: drop it whenever the view
  // changes.
  useEffect(() => {
    setHighlightAction(null);
    window.getSelection()?.removeAllRanges();
  }, [treeId, selectedNodeId, content?.responseRevision, showAllTurns, showFullTrace]);

  // The in-progress ask and the hover-linked pair, unlike the action bar, hold
  // no cached geometry: both re-resolve their passage against whatever
  // projection is on screen, so a mere transcript toggle must not drop them —
  // only a node or revision change invalidates the anchor. Declared before the
  // restore below so that when both fire in the same pass, the restore wins.
  useEffect(() => {
    setAskAnchor(null);
    setLinkedAnchorNodeId(null);
  }, [treeId, selectedNodeId, content?.responseRevision]);

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
  // subsequently opened edit warning. Bail on an unchanged id list: every
  // research event rebuilds the highlights array (4×/s while any run in the
  // tree streams), and adopting each fresh identity re-ran the paint effect's
  // full text-node walk per event. Highlights are append/remove-only with
  // unique ids, so id equality means the anchors are unchanged too.
  useEffect(() => {
    if (!selectedDetailNode) {
      return;
    }
    setContent((current) => {
      if (current?.node.id !== selectedDetailNode.id) {
        return current;
      }
      const previous = current.node.highlights ?? [];
      const next = selectedDetailNode.highlights ?? [];
      if (
        previous.length === next.length &&
        previous.every((highlight, index) => highlight.id === next[index].id)
      ) {
        return current;
      }
      return {
        ...current,
        node: {
          ...current.node,
          highlights: selectedDetailNode.highlights,
        },
      };
    });
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
  // Consumed only by the anchor paint effects, which read each node's id and
  // immutable queryAnchor — so keep the previous array identity while the id
  // list is unchanged. `childNodes` is rebuilt by every research event (4×/s
  // while any run in the tree streams, e.g. a follow-up streaming its
  // preview), and a fresh identity per event re-resolved and repainted every
  // anchored passage each time. Cards render from `childNodes` directly and
  // still see fresh prompts/previews/statuses.
  const anchoredChildrenRef = useRef<ResearchNode[]>([]);
  const anchoredChildren = useMemo(() => {
    const next = childNodes.filter((node) => node.queryAnchor);
    const previous = anchoredChildrenRef.current;
    if (
      previous.length !== next.length ||
      !previous.every((node, index) => node.id === next[index].id)
    ) {
      anchoredChildrenRef.current = next;
    }
    return anchoredChildrenRef.current;
  }, [childNodes]);
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
    // Full-trace is a per-node reading choice, not a sticky session mode: each
    // node opens on its answer so revealing one node's transcript never flips
    // the default view for the next.
    setShowFullTrace(false);
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
      // A node's transcript-view choice does not carry to the next node it is
      // reset with the selection, matching the answer-first default.
      setShowFullTrace(false);
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

  // Deep paths collapse to "root / … / parent / current": the intermediate
  // crumbs add little wayfinding value at this depth, and rendering them all
  // squeezes every crumb into unreadable slivers.
  const breadcrumbDisplay = useMemo(() => {
    type BreadcrumbEntry =
      | { kind: "node"; node: ResearchNode; index: number }
      | { kind: "ellipsis"; count: number };
    if (breadcrumb.length <= 4) {
      return breadcrumb.map(
        (node, index): BreadcrumbEntry => ({ kind: "node", node, index }),
      );
    }
    return [
      { kind: "node", node: breadcrumb[0], index: 0 },
      { kind: "ellipsis", count: breadcrumb.length - 3 },
      {
        kind: "node",
        node: breadcrumb[breadcrumb.length - 2],
        index: breadcrumb.length - 2,
      },
      {
        kind: "node",
        node: breadcrumb[breadcrumb.length - 1],
        index: breadcrumb.length - 1,
      },
    ] satisfies BreadcrumbEntry[];
  }, [breadcrumb]);

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
  // A conversation node's whole timeline is the document: there is no
  // "answer" fold to collapse to and no fuller trace to reveal (tool
  // payloads never survived the export).
  const isConversationContent = content?.node.kind === "conversation";
  const hasTranscriptActivity =
    !isConversationContent && timelineItemsContainTranscriptActivity(timelineItems);
  const displayedTimelineItems =
    isConversationContent || showFullTrace ? timelineItems : answerTimelineItems;
  // A run trace reads bottom-up (the answer is the tail), so its window keeps
  // the newest items; a conversation reads top-down from its opening
  // question, so its window keeps the head with the remainder behind the
  // expander.
  const visibleTimelineItems =
    showAllTurns || displayedTimelineItems.length <= TIMELINE_ITEM_RENDER_WINDOW
      ? displayedTimelineItems
      : isConversationContent
        ? displayedTimelineItems.slice(0, TIMELINE_ITEM_RENDER_WINDOW)
        : displayedTimelineItems.slice(-TIMELINE_ITEM_RENDER_WINDOW);
  const hiddenTimelineItemCount = displayedTimelineItems.length - visibleTimelineItems.length;
  const rawAnswer = useMemo(
    () => assistantTextFromTimelineItems(answerTimelineItems),
    [answerTimelineItems],
  );
  // The copyable form of a conversation node: the whole exchange with role
  // labels, not the assistant-only fold (which would mash unrelated answers
  // together with their questions dropped).
  const conversationCopyText = useMemo(
    () =>
      isConversationContent && content
        ? formatPlainTextTranscript(content.turns, "Assistant")
        : null,
    [content, isConversationContent],
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
  const answerWordCount = useMemo(
    () => countResearchDocumentWords(conversationCopyText ?? rawAnswer),
    [conversationCopyText, rawAnswer],
  );

  // Diagram rendering and other child-owned Markdown controls can replace text
  // nodes without changing the transcript items. Observe those commits so saved
  // ranges are rebuilt against the current rendered projection. Query-anchor
  // passages (and an in-progress ask) resolve against the same projection, so
  // they need the observer even when the node has no saved highlights —
  // without it their paints and card offsets go stale after a diagram lands.
  const hasAnchoredPassages = anchoredChildren.length > 0 || Boolean(askAnchor);
  useEffect(() => {
    const root = responseContentRootRef.current;
    if (
      !root ||
      !content?.responseRevision ||
      (!content.node.highlights?.length && !hasAnchoredPassages) ||
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
    hasAnchoredPassages,
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

  // Measure every resolved anchor's connector: from the answer column's gutter
  // edge at the passage's first line to the left edge of its follow-up card.
  // Depends on resolvedCardTops so each elbow lands on the card's settled
  // (collision-resolved) placement.
  useLayoutEffect(() => {
    const root = responseContentRootRef.current;
    const grid = responseGridRef.current;
    const aside = followupsAsideRef.current;
    if (!root || !grid || !aside) {
      setAnchorConnectors([]);
      return;
    }
    const gridRect = grid.getBoundingClientRect();
    const sx = Math.round(root.getBoundingClientRect().right - gridRect.left) + 8;
    // First pass: resolve each connector's raw endpoints.
    const geometry = anchoredRangeOffsetsRef.current.flatMap((entry) => {
      const range = rangeForTextOffsets(root, entry.start, entry.end);
      const card = aside.querySelector<HTMLElement>(
        `.research-followup-card.is-anchored[data-node-id="${CSS.escape(entry.id)}"]`,
      );
      const firstLine = Array.from(range?.getClientRects() ?? []).find(
        (rect) => rect.width > 0,
      );
      if (!card || !firstLine) {
        return [];
      }
      const cardRect = card.getBoundingClientRect();
      const sy = Math.round(firstLine.top + firstLine.height / 2 - gridRect.top);
      const ex = Math.round(cardRect.left - gridRect.left) - 6;
      const ey = Math.round(cardRect.top - gridRect.top) + 17;
      return [{ id: entry.id, sx, sy, ex, ey }];
    });
    // Second pass: connectors share the same gutter, so their vertical runs
    // would stack on one x line. Assign each run the lowest lane not taken by
    // an overlapping neighbour (greedy interval colouring, top-to-bottom), then
    // fan lanes leftward into the gutter — capped per-run at a fraction of its
    // span so a run never crowds the passage edge.
    const lanes: number[] = [];
    const laneByIndex = new Map<number, number>();
    geometry
      .map((g, index) => ({ index, top: Math.min(g.sy, g.ey), bottom: Math.max(g.sy, g.ey) }))
      .sort((a, b) => a.top - b.top || a.index - b.index)
      .forEach(({ index, top, bottom }) => {
        let lane = lanes.findIndex((occupiedUntil) => occupiedUntil <= top);
        if (lane === -1) {
          lane = lanes.length;
        }
        lanes[lane] = bottom;
        laneByIndex.set(index, lane);
      });
    const next = geometry.map((g, index) => {
      const lane = laneByIndex.get(index) ?? 0;
      const maxOffset = CONNECTOR_STAGGER_FRACTION * (g.ex - g.sx);
      const offset = Math.min(lane * CONNECTOR_STAGGER_STEP, maxOffset);
      const midX = Math.round((g.sx + g.ex) / 2 - offset);
      return {
        id: g.id,
        d: connectorElbowPath(g.sx, g.sy, g.ex, g.ey, midX),
        x: g.sx,
        y: g.sy,
      };
    });
    setAnchorConnectors(next);
  }, [anchoredCardTops, highlightDomNonce, resolvedCardTops]);

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
    // Highlights are not offered on conversation nodes: the answer-v1
    // projection is one flat answer document with no per-turn addressing, so
    // anchors into a multi-turn timeline would not survive view changes.
    if (content?.node.kind === "conversation") {
      setHighlightAction(null);
      return;
    }
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
    // Tool calls, thinking, and other non-text rows are transcript machinery,
    // not answer prose: never offer highlight/ask when the selection touches
    // one, whether it sits inside such a row or drags across it.
    if (selectionTouchesNonTextRow(root, range)) {
      setHighlightAction(null);
      return;
    }
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
    // Keep the quote's surrounding context inside the message it belongs to so
    // the anchor resolves the same in either transcript view (see
    // enclosingMessageFlatBounds).
    const messageBounds = enclosingMessageFlatBounds(root, range);
    const contextFloor = messageBounds?.start ?? 0;
    const contextCeil = messageBounds?.end ?? projection.length;
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
        Math.max(contextFloor, span.start - RESEARCH_HIGHLIGHT_CONTEXT_LENGTH),
        span.start,
      ),
      suffix: textContextSlice(
        projection,
        span.end,
        Math.min(contextCeil, span.end + RESEARCH_HIGHLIGHT_CONTEXT_LENGTH),
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
  }, [content?.node.kind, content?.responseRevision]);

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

  // Passage-side hover behavior: hit-test the pointer against the resolved
  // saved-highlight and query-anchor ranges (rAF-throttled — the walk is cheap
  // but not free). Saved highlights get a pointer cursor to advertise their
  // click behavior; query anchors link to the follow-up card they produced.
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
        anchoredRangeOffsetsRef.current.length > 0 || resolvedHighlightsRef.current.length > 0
          ? flatOffsetAtPoint(root, clientX, clientY)
          : null;
      const overHighlight =
        offset !== null &&
        resolvedHighlightsRef.current.some(({ start, end }) => offset >= start && offset < end);
      const id =
        offset === null
          ? null
          : anchoredRangeOffsetsRef.current.find(
              ({ start, end }) => offset >= start && offset < end,
            )?.id ?? null;
      setPointerOverHighlight((current) =>
        current === overHighlight ? current : overHighlight,
      );
      setLinkedAnchorNodeId((current) => (current === id ? current : id));
    });
  }, []);

  const unlinkAnchorPointer = useCallback(() => {
    if (anchorHoverFrameRef.current !== null) {
      window.cancelAnimationFrame(anchorHoverFrameRef.current);
      anchorHoverFrameRef.current = null;
    }
    setPointerOverHighlight(false);
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
    // preventScroll matters: mid-transition the composer still sits at the top
    // of the rail, and a scrolling focus would yank the page up there and then
    // watch the composer slide back out of the viewport. The slide ends beside
    // the quoted passage — right where the user just selected — so keeping the
    // scroll position keeps the composer in view.
    window.requestAnimationFrame(() =>
      followupTextareaRef.current?.focus({ preventScroll: true }),
    );
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
    // Documents and exported conversations never have a session: their
    // follow-ups launch fresh runs that carry the content as context.
    const followupNodeLaunchesFresh =
      followupNode?.kind === "document" || followupNode?.kind === "conversation";
    // Mirrors the submit button's disabled conditions: Cmd+Enter must not
    // reach the backend (and bounce with an error) from a state the button
    // presents as unavailable — a running node already has a session id.
    if (
      archived ||
      !followupNode ||
      !prompt ||
      submitting ||
      followupNode.status !== "complete" ||
      (!followupNodeLaunchesFresh && !followupNode.nativeSessionId)
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
          // An anchored proposal carries the passage it was asked about;
          // rebind it to the parent's current response revision so the new
          // node's card sits beside that passage. Offsets came from the
          // public page's rendered text, so the exact/prefix/suffix
          // relocation does the real work here.
          const parentRevision =
            proposal.parentNodeId === displayNode?.id
              ? content?.responseRevision ?? null
              : null;
          const child = await onFork(
            proposal.parentNodeId!,
            proposal.prompt,
            {
              publicationId: binding.publicationId,
              commentId: proposal.commentId,
            },
            proposal.anchor && parentRevision
              ? {
                  version: 1,
                  projection: "answer-v1",
                  responseRevision: parentRevision,
                  start: proposal.anchor.start,
                  end: proposal.anchor.end,
                  exact: proposal.anchor.exact,
                  prefix: proposal.anchor.prefix,
                  suffix: proposal.anchor.suffix,
                }
              : null,
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
    const text = conversationCopyText ?? rawAnswer;
    if (!text) {
      return;
    }
    try {
      await writeClipboardText(text);
      onToast(conversationCopyText ? "Copied conversation" : "Copied research answer");
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
      <ResearchDocumentFrame title={headerTitle}>
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
      </ResearchDocumentFrame>
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
  // A conversation node is a severed terminal export: its turns are the
  // document (the first prompt included, so no prompt block above), its
  // follow-ups launch fresh runs like documents, and highlights are not
  // offered — the answer-v1 projection has no multi-turn addressing.
  const isConversation = displayNode.kind === "conversation";
  const awaitingCheckpoint =
    !isDocument &&
    !isConversation &&
    displayNode.status === "complete" &&
    !displayNode.nativeSessionId;

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
        <small className={`is-${child.status}`}>
          {child.status === "running" ? (
            <LoaderCircle
              className="research-spinner research-followup-status-spinner"
              size={11}
              aria-hidden="true"
            />
          ) : null}
          {statusLabel(child.status)}
        </small>
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
            <ResearchHistoryNav
              canGoBack={canGoBack}
              canGoForward={canGoForward}
              backTitle={`Back (${IS_MAC ? "⌘[" : "Ctrl+["})`}
              forwardTitle={`Forward (${IS_MAC ? "⌘]" : "Ctrl+]"})`}
              onBack={goBack}
              onForward={goForward}
            />
            <div className="research-breadcrumb" aria-label="Research path">
              {breadcrumbDisplay.map((entry, displayIndex) =>
                entry.kind === "ellipsis" ? (
                  <span key="ellipsis">
                    <span className="research-breadcrumb-separator">/</span>
                    <span
                      className="research-breadcrumb-ellipsis"
                      title={`${entry.count} earlier ${entry.count === 1 ? "step" : "steps"}`}
                    >
                      …
                    </span>
                  </span>
                ) : (
                  <span key={entry.node.id}>
                    {displayIndex > 0 ? (
                      <span className="research-breadcrumb-separator">/</span>
                    ) : null}
                    <button
                      className="control-button"
                      type="button"
                      onClick={() => selectNode(entry.node.id)}
                    >
                      {entry.index === 0
                        ? detail.tree.title
                        : entry.node.title ?? entry.node.prompt}
                    </button>
                  </span>
                ),
              )}
            </div>
            {displayNode.origin === "terminalExport" ? (
              <span
                className="research-provenance-badge"
                title="This conversation was exported from a terminal session: a point-in-time copy whose content ran with the terminal's full permissions. Review it before publishing."
              >
                <Terminal size={12} aria-hidden="true" />
                Exported from terminal
              </span>
            ) : null}
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
              {!isDocument && !isConversation ? (
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
              <div ref={responseGridRef} className="research-response-grid">
                {anchorConnectors.length > 0 ? (
                  <svg className="research-anchor-connector" aria-hidden="true">
                    {anchorConnectors.map((connector) => (
                      <g
                        key={connector.id}
                        className={`research-anchor-connector-pair${
                          linkedAnchorNodeId === connector.id ? " is-anchor-linked" : ""
                        }`}
                      >
                        <path d={connector.d} />
                        <circle cx={connector.x} cy={connector.y} r={2} />
                      </g>
                    ))}
                  </svg>
                ) : null}
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
                                  : "Working…"
                                : "No response is available."}
                    </p>
                  ) : (
                    <>
                      {hiddenTimelineItemCount > 0 && !isConversation ? (
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
                        className={`research-response-content-root${pointerOverHighlight ? " is-highlight-hovered" : ""}`}
                        onMouseUp={captureHighlightSelection}
                        onKeyUp={captureHighlightSelection}
                        onClick={selectHighlightAtPoint}
                        onMouseMove={linkAnchorUnderPointer}
                        onMouseLeave={unlinkAnchorPointer}
                      >
                        {visibleTimelineItems.map((item) => (
                          <ResearchTimelineItem
                            key={item.key}
                            item={item}
                            conversation={isConversation}
                          />
                        ))}
                      </div>
                      {hiddenTimelineItemCount > 0 && isConversation ? (
                        // Conversations window from the top (they read from
                        // their opening question), so the expander sits at
                        // the bottom where the hidden turns continue.
                        <button
                          type="button"
                          className="control-button research-show-earlier"
                          onClick={expandAllTurns}
                        >
                          Show {hiddenTimelineItemCount} more turn
                          {hiddenTimelineItemCount === 1 ? "" : "s"}
                        </button>
                      ) : null}
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
                      {isConversation ? // A conversation's timestamps span the source terminal
                      // session's lifetime, not a generation — a bare
                      // duration here would read as run time.
                      null : generationDuration !== null ? (
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
                      {displayNode.status === "complete" &&
                      (conversationCopyText ?? rawAnswer) ? (
                        <button
                          type="button"
                          className="control-button research-answer-copy"
                          title={
                            isConversation
                              ? "Copy conversation as Markdown"
                              : "Copy answer as Markdown"
                          }
                          aria-label={
                            isConversation
                              ? "Copy conversation as Markdown"
                              : "Copy answer as Markdown"
                          }
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
                            : isConversation
                              ? "Ask about this conversation…"
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
                          {proposal.anchor ? (
                            <span className="research-followup-quote">
                              {quoteDisplayText(proposal.anchor.exact)}
                            </span>
                          ) : null}
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
                    {(() => {
                      // Publication does not understand conversation nodes
                      // yet (the draft builder and validators are Q/A-shaped)
                      // — a purposeful refusal beats their internal errors.
                      const conversationPublishNote =
                        "Publishing exported conversations isn't available yet";
                      const rootIsConversation = detail.nodes.some(
                        (candidate) =>
                          candidate.id === detail.tree.rootNodeId &&
                          candidate.kind === "conversation",
                      );
                      const rootReady = detail.nodes.some(
                        (candidate) =>
                          candidate.id === detail.tree.rootNodeId &&
                          isTerminalResearchStatus(candidate.status),
                      );
                      return (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            className="control-button"
                            disabled={
                              !isTerminalResearchStatus(node.status) ||
                              node.kind === "conversation"
                            }
                            title={
                              node.kind === "conversation"
                                ? conversationPublishNote
                                : isTerminalResearchStatus(node.status)
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
                            disabled={!rootReady || rootIsConversation}
                            title={
                              rootIsConversation
                                ? conversationPublishNote
                                : rootReady
                                  ? undefined
                                  : "The root result must finish before publishing the tree"
                            }
                            onClick={() => openResearchPublisher("tree", node)}
                          >
                            <Share2 size={13} aria-hidden="true" />
                            <span>Publish research</span>
                          </button>
                        </>
                      );
                    })()}
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
              <DocumentComposer
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
