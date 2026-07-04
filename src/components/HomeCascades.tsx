import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { AgentStatusTone } from "../lib/appHelpers";

export interface HomeCascadeQueuedTurn {
  text: string;
  pauseAfter: boolean;
  waitForAgentId?: string | null;
  waitForLabel?: string | null;
}

export interface HomeCascadeWorkstream {
  agentId: string;
  paneId: string;
  title: string;
  statusTone: AgentStatusTone;
  statusClass: string;
  waitingOnPane: boolean;
  latestUserTurn: string | null;
  queuedTurns: HomeCascadeQueuedTurn[];
}

interface HomeCascadesProps {
  workstreams: HomeCascadeWorkstream[];
  onActivatePane: (paneId: string) => void;
}

interface LinkPath {
  key: string;
  d: string;
}

const LONG_TEXT_CHARS = 132;

const STATUS_TONE_LABELS: Record<AgentStatusTone, string> = {
  active: "running",
  pending: "starting",
  attention: "awaiting input",
  done: "done",
  error: "failed",
  idle: "idle",
};

function queuedTurnKey(workstream: HomeCascadeWorkstream, index: number) {
  return `${workstream.agentId}:${index}`;
}

function currentTurnKey(workstream: HomeCascadeWorkstream) {
  return `${workstream.agentId}:current`;
}

function isShortCommand(text: string) {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 18 && !/\s/.test(trimmed);
}

function shouldOfferExpand(text: string) {
  return text.length > LONG_TEXT_CHARS || text.split(/\r\n|\r|\n/).length > 2;
}

function statusDotClass(workstream: HomeCascadeWorkstream) {
  return [
    "pane-tab-dot",
    `status-${workstream.statusTone}`,
    workstream.statusClass,
    workstream.waitingOnPane ? "is-waiting-on-pane" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function statusLabel(workstream: HomeCascadeWorkstream) {
  return workstream.waitingOnPane
    ? "waiting on another pane"
    : STATUS_TONE_LABELS[workstream.statusTone];
}

function stopButtonPropagation(event: ReactMouseEvent<HTMLElement>) {
  event.stopPropagation();
}

function currentTurnText(workstream: HomeCascadeWorkstream) {
  return workstream.latestUserTurn ?? "No turn yet";
}

function waitLinkPath(fromRect: DOMRect, toRect: DOMRect, baseRect: DOMRect) {
  const x1 = fromRect.right - baseRect.left + 2;
  const y1 = fromRect.top + fromRect.height / 2 - baseRect.top;
  const x2 = toRect.left - baseRect.left - 2;
  const y2 = toRect.top + toRect.height / 2 - baseRect.top;
  const direction = x2 >= x1 ? 1 : -1;
  const dx = Math.max(42, Math.abs(x2 - x1) * 0.45);
  return [
    `M ${x1} ${y1}`,
    `C ${x1 + direction * dx} ${y1},`,
    `${x2 - direction * dx} ${y2},`,
    `${x2} ${y2}`,
  ].join(" ");
}

// Keep the fade mask in sync with what the rail actually clips on each side.
function updateRailClipClasses(rail: HTMLElement) {
  const clippedLeft = rail.scrollLeft > 1;
  const clippedRight = rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1;
  rail.classList.toggle("is-clipped-left", clippedLeft);
  rail.classList.toggle("is-clipped-right", clippedRight);
}

export default function HomeCascades({ workstreams, onActivatePane }: HomeCascadesProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const headerRefs = useRef(new Map<string, HTMLElement>());
  const queuedRefs = useRef(new Map<string, HTMLElement>());
  const railRefs = useRef(new Map<string, HTMLElement>());
  const [links, setLinks] = useState<LinkPath[]>([]);
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 });
  const [openCards, setOpenCards] = useState<Set<string>>(() => new Set());
  const workstreamByAgentId = useMemo(
    () => new Map(workstreams.map((workstream) => [workstream.agentId, workstream])),
    [workstreams],
  );
  // Agents that some queued turn (in any lane) is waiting on: their latest turn
  // still feeds pending work, so it shouldn't fade even if the agent is done.
  const waitTargetAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const workstream of workstreams) {
      for (const turn of workstream.queuedTurns) {
        if (turn.waitForAgentId) {
          ids.add(turn.waitForAgentId);
        }
      }
    }
    return ids;
  }, [workstreams]);

  const setHeaderRef = useCallback((agentId: string, element: HTMLElement | null) => {
    if (element) {
      headerRefs.current.set(agentId, element);
    } else {
      headerRefs.current.delete(agentId);
    }
  }, []);

  const setQueuedRef = useCallback((key: string, element: HTMLElement | null) => {
    if (element) {
      queuedRefs.current.set(key, element);
    } else {
      queuedRefs.current.delete(key);
    }
  }, []);

  const setRailRef = useCallback((agentId: string, element: HTMLElement | null) => {
    if (element) {
      railRefs.current.set(agentId, element);
    } else {
      railRefs.current.delete(agentId);
    }
  }, []);

  const toggleCardOpen = useCallback((key: string) => {
    setOpenCards((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) {
      setLinks([]);
      setSvgSize({ width: 0, height: 0 });
      return;
    }

    let frame = 0;
    const measure = () => {
      const baseRect = wrap.getBoundingClientRect();
      const nextLinks: LinkPath[] = [];

      for (const rail of railRefs.current.values()) {
        updateRailClipClasses(rail);
      }

      for (const workstream of workstreams) {
        for (let index = 0; index < workstream.queuedTurns.length; index += 1) {
          const turn = workstream.queuedTurns[index];
          if (!turn.waitForAgentId || !workstreamByAgentId.has(turn.waitForAgentId)) {
            continue;
          }
          const from = headerRefs.current.get(turn.waitForAgentId);
          const to = queuedRefs.current.get(queuedTurnKey(workstream, index));
          if (!from || !to) {
            continue;
          }
          nextLinks.push({
            key: `${turn.waitForAgentId}:${workstream.agentId}:${index}:wait`,
            d: waitLinkPath(
              from.getBoundingClientRect(),
              to.getBoundingClientRect(),
              baseRect,
            ),
          });
        }
      }

      setSvgSize({
        width: Math.max(wrap.scrollWidth, baseRect.width),
        height: Math.max(wrap.scrollHeight, baseRect.height),
      });
      setLinks(nextLinks);
    };
    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };

    scheduleMeasure();
    window.addEventListener("resize", scheduleMeasure);
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(wrap);
    // Scrolling a rail moves link endpoints and changes which edges are clipped.
    const rails = Array.from(railRefs.current.values());
    for (const rail of rails) {
      rail.addEventListener("scroll", scheduleMeasure, { passive: true });
      observer.observe(rail);
    }
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleMeasure);
      for (const rail of rails) {
        rail.removeEventListener("scroll", scheduleMeasure);
      }
      observer.disconnect();
    };
  }, [openCards, workstreamByAgentId, workstreams]);

  if (workstreams.length === 0) {
    return null;
  }

  const isSettled = (workstream: HomeCascadeWorkstream) =>
    (workstream.statusTone === "done" || workstream.statusTone === "idle") &&
    !waitTargetAgentIds.has(workstream.agentId);

  const activatePaneFromCard = (
    workstream: HomeCascadeWorkstream,
    event: ReactKeyboardEvent<HTMLElement>,
  ) => {
    // Ignore keys bubbling from the expander / wait-pill buttons inside the card.
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivatePane(workstream.paneId);
    }
  };

  const renderExpandToggle = (key: string, open: boolean) => (
    <button
      type="button"
      className="home-cascade-more"
      onClick={(event) => {
        stopButtonPropagation(event);
        toggleCardOpen(key);
      }}
    >
      {open ? "⌃ less" : "⌄ more"}
    </button>
  );

  const renderLinkSvg = () => (
    <svg
      className="home-cascade-links"
      width={svgSize.width}
      height={svgSize.height}
      viewBox={`0 0 ${svgSize.width} ${svgSize.height}`}
      aria-hidden="true"
    >
      <defs>
        <marker
          id="home-cascade-wait-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L8 4 L0 8 z" />
        </marker>
      </defs>
      {links.map((link) => (
        <path
          key={link.key}
          className="home-cascade-link home-cascade-link--wait"
          d={link.d}
          markerEnd="url(#home-cascade-wait-arrow)"
        />
      ))}
    </svg>
  );

  const renderCurrentCard = (workstream: HomeCascadeWorkstream) => {
    const key = currentTurnKey(workstream);
    const open = openCards.has(key);
    const expandable =
      workstream.latestUserTurn !== null && shouldOfferExpand(workstream.latestUserTurn);
    return (
      <div
        className={[
          "home-cascade-card",
          "home-cascade-card--current",
          `tone-${workstream.statusTone}`,
          workstream.latestUserTurn ? "" : "is-empty",
          workstream.latestUserTurn && isSettled(workstream) ? "is-settled" : "",
          open ? "is-open" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={currentTurnText(workstream)}
      >
        <span className="home-cascade-card-text">{currentTurnText(workstream)}</span>
        {expandable ? renderExpandToggle(key, open) : null}
      </div>
    );
  };

  const renderQueuedCard = (
    workstream: HomeCascadeWorkstream,
    turn: HomeCascadeQueuedTurn,
    index: number,
  ) => {
    const key = queuedTurnKey(workstream, index);
    const target = turn.waitForAgentId ? workstreamByAgentId.get(turn.waitForAgentId) : null;
    const waitLabel = turn.waitForLabel ?? target?.title ?? "selected terminal";
    const open = openCards.has(key);
    const expandable = shouldOfferExpand(turn.text);
    return (
      <div
        key={key}
        ref={(element) => setQueuedRef(key, element)}
        className={[
          "home-cascade-card",
          "home-cascade-card--queued",
          turn.waitForAgentId ? "has-wait" : "",
          isShortCommand(turn.text) ? "is-short-command" : "",
          open ? "is-open" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={turn.text}
        role="button"
        tabIndex={0}
        onClick={() => onActivatePane(workstream.paneId)}
        onKeyDown={(event) => activatePaneFromCard(workstream, event)}
      >
        <span className="home-cascade-card-text">{turn.text}</span>
        {turn.waitForAgentId ? (
          target ? (
            <button
              type="button"
              className="home-cascade-wait-pill"
              title={`Waiting on ${waitLabel} — click to open it`}
              onClick={(event) => {
                stopButtonPropagation(event);
                onActivatePane(target.paneId);
              }}
            >
              {waitLabel}
            </button>
          ) : (
            <span className="home-cascade-wait-pill" title={`Waiting on ${waitLabel}`}>
              {waitLabel}
            </span>
          )
        ) : null}
        {expandable ? renderExpandToggle(key, open) : null}
      </div>
    );
  };

  return (
    <section className="home-cascades" aria-label="Agent workstreams">
      <div className="home-cascade-view home-cascade-lanes" ref={wrapRef}>
        {renderLinkSvg()}
        {workstreams.map((workstream) => (
          <div key={workstream.agentId} className="home-cascade-lane">
            <button
              type="button"
              ref={(element) => setHeaderRef(workstream.agentId, element)}
              className="home-cascade-lane-head"
              aria-label={`Open ${workstream.title} — ${statusLabel(workstream)}`}
              onClick={() => onActivatePane(workstream.paneId)}
            >
              <div className="home-cascade-title">
                <span className={statusDotClass(workstream)} aria-hidden="true" />
                <span>{workstream.title}</span>
              </div>
            </button>
            <div
              className="home-cascade-rail"
              ref={(element) => setRailRef(workstream.agentId, element)}
            >
              {renderCurrentCard(workstream)}
              {workstream.queuedTurns.map((turn, index) => (
                <div key={queuedTurnKey(workstream, index)} className="home-cascade-lane-step">
                  <span className="home-cascade-rail-line" aria-hidden="true" />
                  {renderQueuedCard(workstream, turn, index)}
                  {turn.pauseAfter ? (
                    <span className="home-cascade-gate" title="Pause after previous turn">
                      ⏸
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
