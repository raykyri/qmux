import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

export type HomeCascadeView = "lanes" | "columns";

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
  groupLabel: string;
  locationLabel: string | null;
  adapterLabel: string;
  statusTone: string;
  statusClass: string;
  statusLabel: string | null;
  waitingOnPane: boolean;
  latestUserTurn: string | null;
  queuedTurns: HomeCascadeQueuedTurn[];
}

interface HomeCascadesProps {
  workstreams: HomeCascadeWorkstream[];
  view: HomeCascadeView;
  onViewChange: (view: HomeCascadeView) => void;
  onActivatePane: (paneId: string) => void;
}

type LinkKind = "seq" | "wait";

interface LinkPath {
  key: string;
  kind: LinkKind;
  d: string;
}

const LONG_TEXT_CHARS = 132;

function queuedTurnKey(workstream: HomeCascadeWorkstream, index: number) {
  return `${workstream.agentId}:${index}`;
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

function metaPathLabel(workstream: HomeCascadeWorkstream) {
  const path = workstream.locationLabel;
  const group = workstream.groupLabel;
  if (!path) {
    return group;
  }
  // groupLabel almost always mirrors the repo dir already present in the path
  // (e.g. group "exwiki" vs path "~/Code/exwiki"); drop it when redundant.
  const lastSegment = path.split(/[\s/·]+/).filter(Boolean).pop() ?? "";
  if (!group || group === lastSegment || path.includes(`/${group}`)) {
    return path;
  }
  return `${group} · ${path}`;
}

function stopButtonPropagation(event: ReactMouseEvent<HTMLElement>) {
  event.stopPropagation();
}

function currentTurnText(workstream: HomeCascadeWorkstream) {
  return workstream.latestUserTurn ?? "No user turn recorded yet";
}

function pathBetweenRects(
  fromRect: DOMRect,
  toRect: DOMRect,
  baseRect: DOMRect,
  kind: LinkKind,
) {
  const cross = Math.abs(fromRect.left - toRect.left) > 64;
  if (kind === "seq" && !cross) {
    const x1 = fromRect.left + fromRect.width / 2 - baseRect.left;
    const y1 = fromRect.bottom - baseRect.top + 1;
    const x2 = toRect.left + toRect.width / 2 - baseRect.left;
    const y2 = toRect.top - baseRect.top - 1;
    const dy = Math.max(10, (y2 - y1) * 0.55);
    return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
  }

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

export default function HomeCascades({
  workstreams,
  view,
  onViewChange,
  onActivatePane,
}: HomeCascadesProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const headerRefs = useRef(new Map<string, HTMLElement>());
  const currentRefs = useRef(new Map<string, HTMLElement>());
  const queuedRefs = useRef(new Map<string, HTMLElement>());
  const [links, setLinks] = useState<LinkPath[]>([]);
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 });
  const [openCards, setOpenCards] = useState<Set<string>>(() => new Set());
  const workstreamByAgentId = useMemo(
    () => new Map(workstreams.map((workstream) => [workstream.agentId, workstream])),
    [workstreams],
  );

  const setHeaderRef = useCallback((agentId: string, element: HTMLElement | null) => {
    if (element) {
      headerRefs.current.set(agentId, element);
    } else {
      headerRefs.current.delete(agentId);
    }
  }, []);

  const setCurrentRef = useCallback((agentId: string, element: HTMLElement | null) => {
    if (element) {
      currentRefs.current.set(agentId, element);
    } else {
      currentRefs.current.delete(agentId);
    }
  }, []);

  const setQueuedRef = useCallback((key: string, element: HTMLElement | null) => {
    if (element) {
      queuedRefs.current.set(key, element);
    } else {
      queuedRefs.current.delete(key);
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

      if (view === "columns") {
        for (const workstream of workstreams) {
          const current = currentRefs.current.get(workstream.agentId);
          const firstQueued = queuedRefs.current.get(queuedTurnKey(workstream, 0));
          if (current && firstQueued) {
            nextLinks.push({
              key: `${workstream.agentId}:current:0`,
              kind: "seq",
              d: pathBetweenRects(
                current.getBoundingClientRect(),
                firstQueued.getBoundingClientRect(),
                baseRect,
                "seq",
              ),
            });
          }
          for (let index = 0; index < workstream.queuedTurns.length - 1; index += 1) {
            if (workstream.queuedTurns[index].pauseAfter) {
              continue;
            }
            const from = queuedRefs.current.get(queuedTurnKey(workstream, index));
            const to = queuedRefs.current.get(queuedTurnKey(workstream, index + 1));
            if (!from || !to) {
              continue;
            }
            nextLinks.push({
              key: `${workstream.agentId}:${index}:${index + 1}`,
              kind: "seq",
              d: pathBetweenRects(
                from.getBoundingClientRect(),
                to.getBoundingClientRect(),
                baseRect,
                "seq",
              ),
            });
          }
        }
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
            kind: "wait",
            d: pathBetweenRects(
              from.getBoundingClientRect(),
              to.getBoundingClientRect(),
              baseRect,
              "wait",
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
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleMeasure);
      observer.disconnect();
    };
  }, [openCards, view, workstreamByAgentId, workstreams]);

  if (workstreams.length === 0) {
    return null;
  }

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
          className={`home-cascade-link home-cascade-link--${link.kind}`}
          d={link.d}
          markerEnd={link.kind === "wait" ? "url(#home-cascade-wait-arrow)" : undefined}
        />
      ))}
    </svg>
  );

  const renderCurrentCard = (workstream: HomeCascadeWorkstream, compact = false) => (
    <div
      ref={(element) => setCurrentRef(workstream.agentId, element)}
      className={`home-cascade-card home-cascade-card--current tone-${workstream.statusTone}${
        workstream.latestUserTurn ? "" : " is-empty"
      }${compact ? " is-compact" : ""}`}
      title={currentTurnText(workstream)}
    >
      <span className={statusDotClass(workstream)} aria-hidden="true" />
      <span className="home-cascade-card-text">{currentTurnText(workstream)}</span>
    </div>
  );

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
      >
        <span className="home-cascade-index">{index + 1}</span>
        <span className="home-cascade-card-text">{turn.text}</span>
        {turn.waitForAgentId ? (
          <span className="home-cascade-wait-pill" title={`Waiting on ${waitLabel}`}>
            {waitLabel}
          </span>
        ) : null}
        {expandable ? (
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
        ) : null}
      </div>
    );
  };

  const renderPauseGate = (key: string, mode: HomeCascadeView) =>
    mode === "lanes" ? (
      <span key={key} className="home-cascade-gate" title="Pause after previous turn">
        ⏸
      </span>
    ) : (
      <div key={key} className="home-cascade-gate-row">
        paused after previous turn
      </div>
    );

  return (
    <section className="home-cascades" aria-label="Agent workstreams">
      <div className="home-cascade-header">
        <div className="home-cascade-segmented" role="tablist" aria-label="Cascade view">
          <button
            type="button"
            className={view === "lanes" ? "is-active" : ""}
            role="tab"
            aria-selected={view === "lanes"}
            onClick={() => onViewChange("lanes")}
          >
            Lanes
          </button>
          <button
            type="button"
            className={view === "columns" ? "is-active" : ""}
            role="tab"
            aria-selected={view === "columns"}
            onClick={() => onViewChange("columns")}
          >
            Columns
          </button>
        </div>
        <div className="home-cascade-legend" aria-hidden="true">
          <span>
            <i className="home-cascade-legend-dot tone-active" /> running
          </span>
          <span>
            <i className="home-cascade-legend-dot tone-attention" /> needs you
          </span>
          <span>
            <i className="home-cascade-legend-dot tone-queued" /> queued
          </span>
          <span>
            <i className="home-cascade-legend-dot tone-wait" /> waiting
          </span>
          <span>
            <i className="home-cascade-legend-dot tone-gate" /> pause gate
          </span>
        </div>
      </div>

      {view === "lanes" ? (
        <div className="home-cascade-view home-cascade-lanes" ref={wrapRef}>
          {renderLinkSvg()}
          {workstreams.map((workstream) => (
            <div
              key={workstream.agentId}
              className="home-cascade-lane"
              onClick={() => onActivatePane(workstream.paneId)}
            >
              <button
                type="button"
                ref={(element) => setHeaderRef(workstream.agentId, element)}
                className="home-cascade-lane-head"
                aria-label={`Open ${workstream.title}`}
                onClick={(event) => {
                  stopButtonPropagation(event);
                  onActivatePane(workstream.paneId);
                }}
              >
                <div className="home-cascade-title">
                  <span className={statusDotClass(workstream)} aria-hidden="true" />
                  <span>{workstream.title}</span>
                  {workstream.statusLabel ? (
                    <span className="home-cascade-status">{workstream.statusLabel}</span>
                  ) : null}
                </div>
                <div className="home-cascade-meta-row">
                  <span className="home-cascade-adapter">{workstream.adapterLabel}</span>
                  <span className="home-cascade-meta" title={metaPathLabel(workstream)}>
                    {metaPathLabel(workstream)}
                  </span>
                </div>
              </button>
              <div className="home-cascade-rail">
                {renderCurrentCard(workstream, true)}
                {workstream.queuedTurns.map((turn, index) => (
                  <div key={queuedTurnKey(workstream, index)} className="home-cascade-lane-step">
                    <span className="home-cascade-rail-line" aria-hidden="true" />
                    {renderQueuedCard(workstream, turn, index)}
                    {turn.pauseAfter
                      ? renderPauseGate(`${queuedTurnKey(workstream, index)}:gate`, "lanes")
                      : null}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="home-cascade-columns-scroll">
          <div className="home-cascade-view home-cascade-columns" ref={wrapRef}>
            {renderLinkSvg()}
            {workstreams.map((workstream) => (
              <div
                key={workstream.agentId}
                className="home-cascade-column"
                onClick={() => onActivatePane(workstream.paneId)}
              >
                <button
                  type="button"
                  ref={(element) => setHeaderRef(workstream.agentId, element)}
                  className="home-cascade-column-head"
                  aria-label={`Open ${workstream.title}`}
                  onClick={(event) => {
                    stopButtonPropagation(event);
                    onActivatePane(workstream.paneId);
                  }}
                >
                  <div className="home-cascade-title">
                    <span className={statusDotClass(workstream)} aria-hidden="true" />
                    <span>{workstream.title}</span>
                  </div>
                  <div className="home-cascade-column-subhead">
                    <span className="home-cascade-adapter">{workstream.adapterLabel}</span>
                    <span className="home-cascade-meta" title={metaPathLabel(workstream)}>
                      {metaPathLabel(workstream)}
                    </span>
                    {workstream.statusLabel ? (
                      <span className="home-cascade-status">{workstream.statusLabel}</span>
                    ) : null}
                  </div>
                </button>
                {renderCurrentCard(workstream)}
                {workstream.queuedTurns.length > 0 ? (
                  workstream.queuedTurns.map((turn, index) => (
                    <div
                      key={queuedTurnKey(workstream, index)}
                      className="home-cascade-column-step"
                    >
                      {renderQueuedCard(workstream, turn, index)}
                      {turn.pauseAfter
                        ? renderPauseGate(`${queuedTurnKey(workstream, index)}:gate`, "columns")
                        : null}
                    </div>
                  ))
                ) : (
                  <div className="home-cascade-empty-queue">No queued turns</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
