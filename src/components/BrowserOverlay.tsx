import {
  ArrowLeft,
  ArrowRight,
  Expand,
  ExternalLink,
  Minimize2,
  RotateCw,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Input } from "./ui";
import type {
  BrowserOverlaySize,
  BrowserPreviewScrollPosition,
} from "../appTypes";
import {
  claimNativeTerminalPointerForWebDrag,
  getHumanBrowserSnapshot,
  listenToHumanBrowserEvents,
  navigateHumanBrowserHistory,
  setNativeTerminalIframeShortcutFallback,
  syncHumanBrowser,
} from "../lib/api";
import type { HumanBrowserSnapshot } from "../lib/api";
import { isHumanBrowserLifecycleBusy } from "../lib/humanBrowserLifecycleQueue";

const MIN_BROWSER_OVERLAY_WIDTH = 360;
const MIN_BROWSER_OVERLAY_HEIGHT = 240;
const BROWSER_OVERLAY_LEFT_INSET_FALLBACK = 64;
const BROWSER_OVERLAY_BOTTOM_INSET = 50;
const HUMAN_BROWSER_LOCATION_POLL_MS = 500;
const HUMAN_BROWSER_NAVIGATION_GRACE_MS = 1200;
const HUMAN_BROWSER_BUSY_RETRY_MS = 250;

function ignoreBrowserCommand(command: Promise<unknown>) {
  void command.catch(() => undefined);
}

function clampSize(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function cssPixelValue(value: string, fallback: number) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// The browser overlay floats over the sidebar + center terminal (leaving a left
// strip of the tabs visible) and renders a URL bound to the active tab. A minimal
// navigation bar at the top shows the current URL and lets the user navigate. The
// close control stays on the left and page controls stay on the right.
interface BrowserOverlayProps {
  paneId: string;
  sourceLabel?: string;
  previewStatus?: ReactNode;
  url: string | null;
  // Bumped when a URL must be replayed. Human-browser Refresh uses the native
  // reload command directly so a just-changed page URL cannot be overwritten.
  reloadNonce: number;
  // True for token-bearing file-server URLs: sandbox the frame so served (possibly
  // untrusted) content gets an opaque origin. Executable previews receive exact-file
  // tokens that cannot fetch other workspace files. Protected previews stay in WebKit.
  sandbox: boolean;
  // Passed to the token-gated file server so Markdown documents rendered in
  // this isolated frame use the same body font as the application. Arbitrary
  // localhost pages remain untouched.
  bodyFontId: string;
  initialPreviewScroll: BrowserPreviewScrollPosition | null;
  size?: BrowserOverlaySize | null;
  fullWidth: boolean;
  toggleShortcutLabel?: string | null;
  // A native child cannot be covered by DOM stacking. Hide it while an app
  // modal/menu is above this overlay, then restore it to the measured slot.
  occluded: boolean;
  // Changes whenever app layout can move a fixed-size overlay without resizing
  // it, ensuring the native child's full bounding rect is republished.
  geometryRevision: number;
  // Navigate to a typed address (a URL, or a bare host that gets http:// prefixed).
  onNavigate: (rawInput: string) => void;
  // Redirects and in-page navigation update the per-pane address state.
  onLocationChange: (url: string) => void;
  onPreviewScroll: (position: BrowserPreviewScrollPosition) => void;
  // Reload the current page.
  onRefresh: () => void;
  // Open the current page, or a protected preview's source file, externally.
  onOpenExternal: (currentUrl?: string) => void;
  // Close the overlay.
  onClose: () => void;
  // Persist a user-resized overlay size in the app's per-pane React state.
  onResize: (size: BrowserOverlaySize) => void;
  // Expand across the transcript pane, or restore the browser's saved width.
  onFullWidthChange: (fullWidth: boolean) => void;
}

export default function BrowserOverlay({
  paneId,
  sourceLabel,
  previewStatus,
  url,
  reloadNonce,
  sandbox,
  bodyFontId,
  initialPreviewScroll,
  size,
  fullWidth,
  toggleShortcutLabel,
  occluded,
  geometryRevision,
  onNavigate,
  onLocationChange,
  onPreviewScroll,
  onRefresh,
  onOpenExternal,
  onClose,
  onResize,
  onFullWidthChange,
}: BrowserOverlayProps) {
  // Editable copy of the address, re-synced whenever the loaded URL changes so the
  // bar tracks navigation without clobbering what the user is mid-typing.
  const [draft, setDraft] = useState(url ?? "");
  const [resizing, setResizing] = useState(false);
  const [humanBrowserError, setHumanBrowserError] = useState<string | null>(null);
  const [humanBrowserSnapshot, setHumanBrowserSnapshot] = useState<HumanBrowserSnapshot | null>(
    null,
  );
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameScrollRef = useRef<BrowserPreviewScrollPosition | null>(initialPreviewScroll);
  const cleanupResizeRef = useRef<(() => void) | null>(null);
  const humanBrowserUrlRef = useRef(url);
  const humanBrowserOccludedRef = useRef(occluded);
  const humanBrowserNavigationRevisionRef = useRef(reloadNonce);
  const onLocationChangeRef = useRef(onLocationChange);
  const onNavigateRef = useRef(onNavigate);
  const onPreviewScrollRef = useRef(onPreviewScroll);
  const syncHumanBrowserSlotRef = useRef<() => void>(() => undefined);

  const humanBrowser = !sandbox && url !== null;
  const frameUrl = (() => {
    if (!url || !sandbox) {
      return url;
    }
    try {
      const parsed = new URL(url);
      parsed.searchParams.set("qmux-body-font", bodyFontId);
      return parsed.toString();
    } catch {
      return url;
    }
  })();

  humanBrowserUrlRef.current = url;
  humanBrowserOccludedRef.current = occluded;
  humanBrowserNavigationRevisionRef.current = reloadNonce;
  onLocationChangeRef.current = onLocationChange;
  onNavigateRef.current = onNavigate;
  onPreviewScrollRef.current = onPreviewScroll;

  useLayoutEffect(() => {
    if (sourceLabel) overlayRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [sourceLabel]);

  useEffect(() => {
    frameScrollRef.current =
      initialPreviewScroll?.url === url ? initialPreviewScroll : null;
  }, [initialPreviewScroll, url]);

  useEffect(() => {
    if (document.activeElement !== addressInputRef.current) {
      setDraft(url ?? "");
    }
  }, [url]);

  useEffect(() => {
    if (!sandbox || !frameUrl || !url) {
      return;
    }
    const rememberScroll = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) {
        return;
      }
      const message = event.data as { type?: unknown; x?: unknown; y?: unknown } | null;
      if (
        message?.type !== "qmux-preview-scroll" ||
        typeof message.x !== "number" ||
        typeof message.y !== "number" ||
        !Number.isFinite(message.x) ||
        !Number.isFinite(message.y)
      ) {
        return;
      }
      const position = { url, x: message.x, y: message.y };
      frameScrollRef.current = position;
      onPreviewScrollRef.current(position);
    };
    window.addEventListener("message", rememberScroll);
    return () => window.removeEventListener("message", rememberScroll);
  }, [frameUrl, sandbox, url]);

  useLayoutEffect(() => {
    if (!humanBrowser) {
      setHumanBrowserError(null);
      setHumanBrowserSnapshot(null);
      syncHumanBrowserSlotRef.current = () => undefined;
      return;
    }

    let cancelled = false;
    let frame: number | null = null;
    let unlisten: UnlistenFn | null = null;
    let locationPollTimer: number | null = null;
    let busyRetryTimer: number | null = null;
    let locationPollInFlight = false;
    let lastNavigationRevision = humanBrowserNavigationRevisionRef.current;
    let appliedNavigationRevision = lastNavigationRevision;
    let locationEventSequence = 0;
    let locationPollSuppressedUntil = 0;
    let syncSequence = 0;
    let lastSyncedUrl = url;
    let syncInFlight = false;
    let syncPending = false;

    const syncSlot = async () => {
      frame = null;
      if (cancelled || syncInFlight || !syncPending) {
        return;
      }
      syncPending = false;
      const body = bodyRef.current;
      const currentUrl = humanBrowserUrlRef.current;
      if (!body || !currentUrl) {
        return;
      }
      syncInFlight = true;
      const rect = body.getBoundingClientRect();
      const sequence = ++syncSequence;
      const locationSequence = locationEventSequence;
      const navigationRevision = humanBrowserNavigationRevisionRef.current;
      if (navigationRevision !== lastNavigationRevision) {
        lastNavigationRevision = navigationRevision;
        locationPollSuppressedUntil = performance.now() + HUMAN_BROWSER_NAVIGATION_GRACE_MS;
      }
      lastSyncedUrl = currentUrl;
      try {
        const result = await syncHumanBrowser({
          ownerId: paneId,
          url: currentUrl,
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          visible:
            !humanBrowserOccludedRef.current && rect.width >= 1 && rect.height >= 1,
          navigationRevision: humanBrowserNavigationRevisionRef.current,
        });
        if (!cancelled && sequence === syncSequence && result.applied) {
          appliedNavigationRevision = navigationRevision;
          setHumanBrowserError(null);
          if (
            result.snapshot &&
            navigationRevision === humanBrowserNavigationRevisionRef.current &&
            locationSequence === locationEventSequence
          ) {
            setHumanBrowserSnapshot(result.snapshot);
          }
        }
      } catch (error) {
        if (!cancelled && sequence === syncSequence) {
          setHumanBrowserError(error instanceof Error ? error.message : String(error));
          // A close/reopen can interrupt the frontend queue while the old
          // native child is still being created. Its permit can outlast the
          // API's short retry burst; keep the current mounted slot pending.
          if (isHumanBrowserLifecycleBusy(error) && busyRetryTimer === null) {
            busyRetryTimer = window.setTimeout(() => {
              busyRetryTimer = null;
              scheduleSync();
            }, HUMAN_BROWSER_BUSY_RETRY_MS);
          }
        }
      } finally {
        syncInFlight = false;
        if (!cancelled && syncPending) {
          scheduleSync();
        }
      }
    };

    const scheduleSync = () => {
      if (busyRetryTimer !== null) {
        window.clearTimeout(busyRetryTimer);
        busyRetryTimer = null;
      }
      syncPending = true;
      if (!syncInFlight && frame === null) {
        frame = requestAnimationFrame(() => void syncSlot());
      }
    };
    syncHumanBrowserSlotRef.current = scheduleSync;

    const resizeObserver = new ResizeObserver(scheduleSync);
    if (bodyRef.current) {
      resizeObserver.observe(bodyRef.current);
    }
    window.addEventListener("resize", scheduleSync);

    void listenToHumanBrowserEvents((event) => {
      if (cancelled || event.ownerId !== paneId) {
        return;
      }
      // React can publish a typed URL before rAF sends its navigation. Old
      // document callbacks, including popups, must not replace that destination
      // while sync waits in the queue or retries a busy native lifecycle.
      if (
        humanBrowserNavigationRevisionRef.current !== lastNavigationRevision ||
        humanBrowserNavigationRevisionRef.current !== appliedNavigationRevision
      ) {
        return;
      }
      if (event.kind === "newWindow" && event.url) {
        onNavigateRef.current(event.url);
        return;
      }
      if ((event.kind === "navigation" || event.kind === "title") && event.url) {
        locationEventSequence += 1;
        locationPollSuppressedUntil = 0;
        onLocationChangeRef.current(event.url);
      }
    }).then(
      (stop) => {
        if (cancelled) {
          stop();
        } else {
          unlisten = stop;
        }
      },
      (error) => {
        if (!cancelled) {
          setHumanBrowserError(error instanceof Error ? error.message : String(error));
        }
      },
    );

    const pollLocation = async () => {
      if (cancelled || locationPollInFlight || humanBrowserOccludedRef.current) {
        return;
      }
      const navigationRevision = humanBrowserNavigationRevisionRef.current;
      const locationSequence = locationEventSequence;
      // A React navigation render can precede the rAF that sends it to the
      // native child. Do not let a poll from that narrow window restore the
      // page's old URL before syncSlot establishes the navigation grace period.
      if (
        navigationRevision !== lastNavigationRevision ||
        navigationRevision !== appliedNavigationRevision
      ) {
        return;
      }
      locationPollInFlight = true;
      try {
        const snapshot = await getHumanBrowserSnapshot(paneId);
        // Page/history navigation does not increment the typed navigation
        // revision. A newer native event also makes this older poll obsolete.
        if (
          cancelled ||
          navigationRevision !== humanBrowserNavigationRevisionRef.current ||
          navigationRevision !== appliedNavigationRevision ||
          locationSequence !== locationEventSequence
        ) {
          return;
        }
        if (snapshot) {
          setHumanBrowserSnapshot(snapshot);
        }
        if (
          snapshot?.url &&
          snapshot.url !== humanBrowserUrlRef.current &&
          performance.now() >= locationPollSuppressedUntil
        ) {
          onLocationChangeRef.current(snapshot.url);
        }
      } catch {
        // Page-load events remain the primary path. Polling is only the
        // same-document navigation fallback, so a transient miss is harmless.
      } finally {
        locationPollInFlight = false;
      }
    };
    locationPollTimer = window.setInterval(
      () => void pollLocation(),
      HUMAN_BROWSER_LOCATION_POLL_MS,
    );

    scheduleSync();
    return () => {
      cancelled = true;
      syncPending = false;
      syncHumanBrowserSlotRef.current = () => undefined;
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleSync);
      if (locationPollTimer !== null) {
        window.clearInterval(locationPollTimer);
      }
      if (busyRetryTimer !== null) {
        window.clearTimeout(busyRetryTimer);
      }
      unlisten?.();
      if (lastSyncedUrl) {
        void syncHumanBrowser({
          ownerId: paneId,
          url: lastSyncedUrl,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          visible: false,
          navigationRevision: humanBrowserNavigationRevisionRef.current,
        }).catch(() => undefined);
      }
    };
  }, [humanBrowser, paneId]);

  useLayoutEffect(() => {
    syncHumanBrowserSlotRef.current();
  }, [geometryRevision, humanBrowser, occluded, reloadNonce, url]);

  // Keys typed into the framed page belong to its document: the host
  // document's window-level shortcut handlers never fire, and the native key
  // monitor deliberately leaves keys to a healthy WKWebView responder — so
  // every app shortcut (⌘-backtick, the ⌘⇧E toggle that closes this overlay…)
  // goes dead the moment a click lands inside the frame. Report frame focus
  // to the native layer so the monitor claims ⌘ chords for qmux while it
  // holds. Focus crossing into an iframe blurs the host window (its browsing
  // context loses focus) and leaves activeElement on the frame element, so
  // sample on window focus transitions — the framed document never forwards
  // focusin/focusout to this one. The rAF matches the app-level samplers:
  // activeElement settles after the event.
  useEffect(() => {
    if (!url || humanBrowser) {
      return;
    }
    let frame: number | null = null;
    let reported = false;
    const report = (active: boolean) => {
      if (active === reported) {
        return;
      }
      reported = active;
      void setNativeTerminalIframeShortcutFallback(active).catch(() => undefined);
    };
    const sample = () => {
      frame = null;
      report(frameRef.current !== null && document.activeElement === frameRef.current);
    };
    const schedule = () => {
      if (frame === null) {
        frame = requestAnimationFrame(sample);
      }
    };
    window.addEventListener("blur", schedule);
    window.addEventListener("focus", schedule);
    window.addEventListener("focusin", schedule);
    schedule();
    return () => {
      window.removeEventListener("blur", schedule);
      window.removeEventListener("focus", schedule);
      window.removeEventListener("focusin", schedule);
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      // The frame is unmounting (overlay closed, or remounted by the reload
      // key); WebKit fires no focus event for a removed element, so release
      // the claim explicitly instead of leaving it wedged on.
      report(false);
    };
  }, [humanBrowser, url, reloadNonce]);

  useEffect(() => {
    return () => {
      cleanupResizeRef.current?.();
    };
  }, []);

  function startResize(event: ReactPointerEvent<HTMLDivElement>, resizeWidth: boolean) {
    const overlay = overlayRef.current;
    const parent = overlay?.offsetParent instanceof HTMLElement ? overlay.offsetParent : null;
    if (!overlay || !parent) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const releaseNativePointer = claimNativeTerminalPointerForWebDrag();

    const overlayRect = overlay.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const parentStyles = getComputedStyle(parent);
    const leftInset = cssPixelValue(
      parentStyles.getPropertyValue("--browser-overlay-left"),
      BROWSER_OVERLAY_LEFT_INSET_FALLBACK,
    );
    const maxWidth = Math.max(
      MIN_BROWSER_OVERLAY_WIDTH,
      overlayRect.right - parentRect.left - leftInset,
    );
    const maxHeight = Math.max(
      MIN_BROWSER_OVERLAY_HEIGHT,
      parentRect.bottom - overlayRect.top - BROWSER_OVERLAY_BOTTOM_INSET,
    );
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = overlayRect.width;
    const startHeight = overlayRect.height;
    const handle = event.currentTarget;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = resizeWidth ? "nesw-resize" : "ns-resize";
    document.body.style.userSelect = "none";
    setResizing(true);

    const cleanup = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      releaseNativePointer();
      setResizing(false);
      cleanupResizeRef.current = null;
    };

    const stopResize = () => cleanup();

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const width = resizeWidth
        ? clampSize(
            startWidth - (moveEvent.clientX - startX),
            MIN_BROWSER_OVERLAY_WIDTH,
            maxWidth,
          )
        : startWidth;
      const height = clampSize(
        startHeight + (moveEvent.clientY - startY),
        MIN_BROWSER_OVERLAY_HEIGHT,
        maxHeight,
      );
      onResize({ width: Math.round(width), height: Math.round(height) });
    };

    cleanupResizeRef.current?.();
    cleanupResizeRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }

  const overlayStyle: CSSProperties | undefined = size
    ? {
        ...(fullWidth ? {} : { width: `${size.width}px` }),
        height: `${size.height}px`,
      }
    : undefined;
  const closeTitle = toggleShortcutLabel
    ? `Hide browser (Esc, ${toggleShortcutLabel})`
    : "Hide browser (Esc)";
  function navigateHistory(direction: "back" | "forward") {
    if (humanBrowser) {
      ignoreBrowserCommand(navigateHumanBrowserHistory(paneId, direction));
    }
  }

  return (
    <div
      ref={overlayRef}
      className={`browser-overlay${url ? "" : " is-empty"}${fullWidth ? " is-full-width" : ""}${resizing ? " is-resizing" : ""}`}
      style={overlayStyle}
      role="region"
      aria-label={sourceLabel ? "Remote file preview" : "Browser overlay"}
      onKeyDown={(event) => {
        if (sourceLabel && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="browser-overlay-nav">
        <button
          type="button"
          className="icon-button browser-overlay-button browser-overlay-close-button"
          title={closeTitle}
          aria-label="Hide browser"
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
        <div className="browser-overlay-history-controls" role="group" aria-label="Page history">
          <button
            type="button"
            className="icon-button browser-overlay-button"
            title="Go back"
            aria-label="Go back"
            onClick={() => navigateHistory("back")}
            disabled={!humanBrowser || !humanBrowserSnapshot?.canGoBack}
          >
            <ArrowLeft size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button browser-overlay-button"
            title="Go forward"
            aria-label="Go forward"
            onClick={() => navigateHistory("forward")}
            disabled={!humanBrowser || !humanBrowserSnapshot?.canGoForward}
          >
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        </div>
        <form
          className="browser-overlay-nav-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!sourceLabel) onNavigate(draft);
            event.currentTarget.querySelector("input")?.blur();
          }}
        >
          <Input
            ref={addressInputRef}
            type="text"
            className="browser-overlay-url"
            value={sourceLabel ?? draft}
            readOnly={sourceLabel !== undefined}
            aria-label={sourceLabel ? "Remote file path" : "Address"}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => setDraft(url ?? "")}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft(url ?? "");
                event.currentTarget.blur();
              }
            }}
            placeholder="Enter a URL"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
          />
        </form>
        <div className="browser-overlay-nav-controls">
          <button
            type="button"
            className={`icon-button browser-overlay-button${fullWidth ? " is-active" : ""}`}
            title={fullWidth ? "Restore browser width" : "Expand browser to full width"}
            aria-label={fullWidth ? "Restore browser width" : "Expand browser to full width"}
            aria-pressed={fullWidth}
            onClick={() => onFullWidthChange(!fullWidth)}
          >
            {fullWidth ? (
              <Minimize2 size={14} aria-hidden="true" />
            ) : (
              <Expand size={14} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className="icon-button browser-overlay-button"
            title={sourceLabel ? "Refresh from remote" : "Refresh browser"}
            aria-label={sourceLabel ? "Refresh from remote" : "Refresh browser"}
            onClick={onRefresh}
          >
            <RotateCw size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button browser-overlay-button"
            title={sandbox ? "Open source file externally" : "Open in external browser"}
            aria-label={sandbox ? "Open source file externally" : "Open in external browser"}
            onClick={() => onOpenExternal(url ?? undefined)}
            disabled={!url || sourceLabel !== undefined}
          >
            <ExternalLink size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      {previewStatus}
      <div ref={bodyRef} className="browser-overlay-body">
        {humanBrowser ? (
          <div className="browser-overlay-native-slot" aria-label="WebKit browser content">
            {humanBrowserError ? <p>{humanBrowserError}</p> : null}
          </div>
        ) : frameUrl ? (
          <iframe
            key={`${frameUrl}::${reloadNonce}`}
            ref={frameRef}
            className={`browser-overlay-frame${sandbox ? " is-file-content" : ""}`}
            src={frameUrl}
            title="Browser overlay"
            // allow-scripts (so scripted reports still render) without
            // allow-same-origin (opaque origin isolates the preview from qmux).
            sandbox={sandbox ? "allow-scripts" : undefined}
            referrerPolicy="no-referrer"
            onLoad={() => {
              const scroll = frameScrollRef.current;
              if (scroll?.url === url) {
                frameRef.current?.contentWindow?.postMessage(
                  { type: "qmux-preview-scroll-restore", x: scroll.x, y: scroll.y },
                  "*",
                );
              }
            }}
          />
        ) : sourceLabel ? null : (
          <div className="browser-overlay-empty">
            <p>
              Nothing loaded yet. Run <code>qmux open &lt;file&gt;</code> (or enter a
              <code>http://localhost</code> URL above) to render a page here.
            </p>
          </div>
        )}
      </div>
      {fullWidth ? null : (
        <div
          className="browser-overlay-resize-border"
          role="separator"
          aria-label="Resize browser height"
          title="Drag to resize browser height"
          onPointerDown={(event) => startResize(event, false)}
        >
          <div
            className="browser-overlay-resize-corner"
            role="separator"
            aria-label="Resize browser"
            title="Drag to resize browser"
            onPointerDown={(event) => startResize(event, true)}
          />
        </div>
      )}
    </div>
  );
}
