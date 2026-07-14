import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import type { MessageAnnotation, MessageAnnotationAnchor } from "../types";
import {
  TRANSCRIPT_ANNOTATION_CONTEXT_LENGTH,
  buildAnnotationMessage,
  groupAnnotationsByMessage,
  resolveAnnotationOffset,
} from "../lib/transcriptAnnotations";

// One painted registry slot backs every transcript's annotations. In split view
// several TurnOverlays mount at once, so the painted Highlight is the union of
// every layer's ranges: each layer owns a token and feeds its ranges in, and the
// shared repaint rebuilds the single Highlight from all owners. This avoids one
// pane's paint clobbering another's (the failure mode a single owner token has).
const ANNOTATION_HIGHLIGHT_NAME = "qmux-transcript-annotations";

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}
interface HighlightLike {
  add(range: Range): void;
}

function highlightApi(): { registry: HighlightRegistryLike; Highlight: new () => HighlightLike } | null {
  const css = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
  const Highlight = (globalThis as unknown as { Highlight?: unknown }).Highlight;
  if (!css?.highlights || typeof Highlight !== "function") {
    return null;
  }
  return { registry: css.highlights, Highlight: Highlight as new () => HighlightLike };
}

const rangesByOwner = new Map<object, Range[]>();

function repaintAnnotationHighlights() {
  const api = highlightApi();
  if (!api) {
    return;
  }
  const all: Range[] = [];
  for (const ranges of rangesByOwner.values()) {
    all.push(...ranges);
  }
  if (all.length === 0) {
    api.registry.delete(ANNOTATION_HIGHLIGHT_NAME);
    return;
  }
  const painted = new api.Highlight();
  for (const range of all) {
    painted.add(range);
  }
  api.registry.set(ANNOTATION_HIGHLIGHT_NAME, painted);
}

function setOwnerRanges(owner: object, ranges: Range[]) {
  if (ranges.length === 0) {
    rangesByOwner.delete(owner);
  } else {
    rangesByOwner.set(owner, ranges);
  }
  repaintAnnotationHighlights();
}

function clearOwnerRanges(owner: object) {
  if (rangesByOwner.delete(owner)) {
    repaintAnnotationHighlights();
  }
}

// --- DOM offset helpers (a live-selection counterpart to the pure resolver) ---

function textNodesWithin(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

function rangeForTextOffsets(root: HTMLElement, start: number, end: number): Range | null {
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

function offsetWithinRoot(root: HTMLElement, node: Node, nodeOffset: number): number | null {
  if (!root.contains(node)) {
    return null;
  }
  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(root);
  prefixRange.setEnd(node, nodeOffset);
  return prefixRange.cloneContents().textContent?.length ?? 0;
}

function selectionOffsets(root: HTMLElement, range: Range): { start: number; end: number } | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }
  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(root);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const throughRange = document.createRange();
  throughRange.selectNodeContents(root);
  throughRange.setEnd(range.endContainer, range.endOffset);
  const start = prefixRange.cloneContents().textContent?.length ?? 0;
  const end = throughRange.cloneContents().textContent?.length ?? 0;
  return end > start ? { start, end } : null;
}

function textContextSlice(text: string, start: number, end: number): string {
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

// The `.turn-blocks` projection root for the message the range sits inside, when
// both ends share the same one. A selection that straddles two messages (or that
// includes a message header) resolves to null and is ignored.
function messageRootFor(root: HTMLElement, node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const block = element?.closest<HTMLElement>(".turn-blocks[data-message-key]") ?? null;
  return block && root.contains(block) ? block : null;
}

interface ComposeState {
  messageKey: string;
  anchor: MessageAnnotationAnchor;
  left: number;
  top: number;
}

interface ViewState {
  messageKey: string;
  left: number;
  top: number;
}

interface ResolvedRange {
  annotation: MessageAnnotation;
  start: number;
  end: number;
}

export interface TranscriptAnnotationLayerProps {
  agentId: string | null;
  timelineRef: RefObject<HTMLDivElement | null>;
  annotations: MessageAnnotation[];
  onCreate: (
    messageKey: string,
    anchor: MessageAnnotationAnchor,
    comment: string,
  ) => Promise<void>;
  onRemove: (messageKey: string, annotationId: string) => Promise<void>;
  // Inserts assembled annotation text into the composer for review before sending
  // (Phase 2). Absent disables the "Add to composer" action.
  onAddToComposer?: (text: string) => void;
  onError?: (message: string) => void;
}

export default function TranscriptAnnotationLayer({
  agentId,
  timelineRef,
  annotations,
  onCreate,
  onRemove,
  onAddToComposer,
  onError,
}: TranscriptAnnotationLayerProps) {
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<ViewState | null>(null);
  const [domNonce, setDomNonce] = useState(0);
  // Resolved offsets per message key, kept for click hit-testing and popover
  // positioning. Repopulated by the paint effect.
  const resolvedRef = useRef<Map<string, ResolvedRange[]>>(new Map());
  const ownerRef = useRef<object>({});

  const grouped = groupAnnotationsByMessage(annotations);

  // Paint: resolve every annotation against its message's live projection and
  // feed the ranges into the shared registry. Runs after layout and whenever the
  // annotation set or the rendered DOM changes.
  useLayoutEffect(() => {
    const owner = ownerRef.current;
    const timeline = timelineRef.current;
    const resolved = new Map<string, ResolvedRange[]>();
    if (!timeline || !highlightApi() || annotations.length === 0) {
      resolvedRef.current = resolved;
      setOwnerRanges(owner, []);
      return () => clearOwnerRanges(owner);
    }
    const ranges: Range[] = [];
    for (const [messageKey, list] of grouped) {
      const block = timeline.querySelector<HTMLElement>(
        `.turn-blocks[data-message-key="${CSS.escape(messageKey)}"]`,
      );
      if (!block) {
        continue;
      }
      const projection = block.textContent ?? "";
      const resolvedForMessage: ResolvedRange[] = [];
      for (const annotation of list) {
        const offsets = resolveAnnotationOffset(projection, annotation.anchor);
        if (!offsets) {
          continue;
        }
        const range = rangeForTextOffsets(block, offsets.start, offsets.end);
        if (!range) {
          continue;
        }
        ranges.push(range);
        resolvedForMessage.push({ annotation, ...offsets });
      }
      if (resolvedForMessage.length > 0) {
        resolved.set(messageKey, resolvedForMessage);
      }
    }
    resolvedRef.current = resolved;
    setOwnerRanges(owner, ranges);
    return () => clearOwnerRanges(owner);
    // grouped is derived from annotations; domNonce forces a repaint on DOM edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, domNonce, timelineRef]);

  // Streaming and markdown child controls replace text nodes without changing the
  // annotation set; observe those commits so ranges rebuild against the current
  // projection.
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || annotations.length === 0 || typeof MutationObserver === "undefined") {
      return;
    }
    let frame: number | null = null;
    const observer = new MutationObserver(() => {
      if (frame !== null) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setDomNonce((value) => value + 1);
      });
    });
    observer.observe(timeline, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [annotations.length, timelineRef]);

  // Selection / click capture on the timeline: a non-collapsed selection inside
  // one message opens the compose popover; a plain click on an existing
  // annotation opens its notes; a click elsewhere dismisses.
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || !agentId) {
      return;
    }
    const handleMouseUp = (event: MouseEvent) => {
      // Ignore clicks inside our own portaled popovers.
      if (
        event.target instanceof Element &&
        event.target.closest(".transcript-annotation-popover")
      ) {
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return;
      }
      const range = selection.getRangeAt(0);
      const root = messageRootFor(timeline, range.commonAncestorContainer);
      if (!root) {
        setCompose(null);
        setView(null);
        return;
      }
      const messageKey = root.dataset.messageKey;
      if (!messageKey) {
        return;
      }
      if (!selection.isCollapsed) {
        const offsets = selectionOffsets(root, range);
        if (!offsets) {
          return;
        }
        const projection = root.textContent ?? "";
        const exact = projection.slice(offsets.start, offsets.end);
        if (!exact.trim()) {
          return;
        }
        const rect = range.getBoundingClientRect();
        setView(null);
        setCommentDraft("");
        setCompose({
          messageKey,
          anchor: {
            version: 1,
            projection: "transcript-v1",
            start: offsets.start,
            end: offsets.end,
            exact,
            prefix: textContextSlice(
              projection,
              offsets.start - TRANSCRIPT_ANNOTATION_CONTEXT_LENGTH,
              offsets.start,
            ),
            suffix: textContextSlice(
              projection,
              offsets.end,
              offsets.end + TRANSCRIPT_ANNOTATION_CONTEXT_LENGTH,
            ),
          },
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 300)),
          top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 160)),
        });
        return;
      }
      // Collapsed click: open the notes popover when it lands on an annotation.
      const offset = offsetWithinRoot(root, range.startContainer, range.startOffset);
      const resolvedForMessage = resolvedRef.current.get(messageKey);
      if (offset === null || !resolvedForMessage) {
        setCompose(null);
        setView(null);
        return;
      }
      const hit = resolvedForMessage.find(
        (entry) => offset >= entry.start && offset < entry.end,
      );
      if (!hit) {
        setCompose(null);
        setView(null);
        return;
      }
      const range2 = rangeForTextOffsets(root, hit.start, hit.end);
      const rect = range2?.getBoundingClientRect() ?? root.getBoundingClientRect();
      setCompose(null);
      setView({
        messageKey,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 320)),
        top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 200)),
      });
    };
    timeline.addEventListener("mouseup", handleMouseUp);
    return () => timeline.removeEventListener("mouseup", handleMouseUp);
  }, [agentId, timelineRef]);

  // Dismiss popovers on Escape or an outside pointer press.
  useEffect(() => {
    if (!compose && !view) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        (event.target.closest(".transcript-annotation-popover") ||
          event.target.closest(".turn-timeline"))
      ) {
        return;
      }
      setCompose(null);
      setView(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCompose(null);
        setView(null);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [compose, view]);

  const save = useCallback(async () => {
    if (!compose || saving) {
      return;
    }
    const comment = commentDraft.trim();
    if (!comment) {
      return;
    }
    setSaving(true);
    try {
      await onCreate(compose.messageKey, compose.anchor, comment);
      window.getSelection()?.removeAllRanges();
      setCompose(null);
      setCommentDraft("");
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [commentDraft, compose, onCreate, onError, saving]);

  const remove = useCallback(
    async (messageKey: string, annotationId: string) => {
      try {
        await onRemove(messageKey, annotationId);
      } catch (err) {
        onError?.(err instanceof Error ? err.message : String(err));
      }
    },
    [onError, onRemove],
  );

  if (!agentId) {
    return null;
  }

  const viewAnnotations = view ? (grouped.get(view.messageKey) ?? []) : [];

  return (
    <>
      {compose
        ? createPortal(
            <div
              className="transcript-annotation-popover transcript-annotation-compose"
              style={{ left: compose.left, top: compose.top }}
              role="dialog"
              aria-label="Add annotation"
            >
              <div className="transcript-annotation-quote">{compose.anchor.exact}</div>
              <textarea
                className="transcript-annotation-input"
                autoFocus
                value={commentDraft}
                placeholder="Add a note…"
                rows={3}
                onChange={(event) => setCommentDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void save();
                  }
                }}
              />
              <div className="transcript-annotation-actions">
                <button
                  type="button"
                  className="control-button"
                  onClick={() => {
                    setCompose(null);
                    setCommentDraft("");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="control-button is-primary"
                  disabled={saving || !commentDraft.trim()}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Annotate"}
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
      {view && viewAnnotations.length > 0
        ? createPortal(
            <div
              className="transcript-annotation-popover transcript-annotation-notes"
              style={{ left: view.left, top: view.top }}
              role="dialog"
              aria-label="Annotations"
            >
              <div className="transcript-annotation-notes-header">
                {viewAnnotations.length === 1
                  ? "1 annotation"
                  : `${viewAnnotations.length} annotations`}
              </div>
              <ul className="transcript-annotation-list">
                {viewAnnotations.map((annotation) => (
                  <li key={annotation.id} className="transcript-annotation-item">
                    <div className="transcript-annotation-item-quote">
                      {annotation.anchor.exact}
                    </div>
                    <div className="transcript-annotation-item-comment">
                      {annotation.comment}
                    </div>
                    <div className="transcript-annotation-item-actions">
                      <button
                        type="button"
                        className="icon-button"
                        title="Delete annotation"
                        aria-label="Delete annotation"
                        onClick={() => void remove(view.messageKey, annotation.id)}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {onAddToComposer ? (
                <div className="transcript-annotation-actions">
                  <button
                    type="button"
                    className="control-button is-primary"
                    onClick={() => {
                      const message = buildAnnotationMessage(viewAnnotations);
                      if (message) {
                        onAddToComposer(message);
                      }
                      setView(null);
                    }}
                  >
                    Add to composer
                  </button>
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
