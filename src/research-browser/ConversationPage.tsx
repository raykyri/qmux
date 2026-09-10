import { useEffect, useRef, useState } from "react";
import TranscriptMarkdown, {
  TranscriptLinkActionsProvider,
} from "../components/TranscriptMarkdown";
import {
  canContinueThread,
  canFollowUpFrom,
  canRetryResearchNode,
  isActiveResearchStatus,
} from "../lib/researchThreads";
import type { ResearchNodeContent, ResearchTreeDetail } from "../types";
import type { ResearchBrowserSdk } from "./sdk";
import { conversationPath, researchRoute } from "./conversation";

export default function ConversationPage({
  sdk,
  treeId,
  nodeId,
}: {
  sdk: ResearchBrowserSdk;
  treeId: string;
  nodeId?: string;
}) {
  const [data, setData] = useState<{
    detail: ResearchTreeDetail;
    contents: ResearchNodeContent[];
  }>();
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const draftKey = `followup:${treeId}:${nodeId ?? "root"}`;
  const [draft, setDraft] = useState(() =>
    String(sdk.getSnapshot().viewState[draftKey] ?? ""),
  );
  const refreshRef = useRef(() => {});
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoredScroll = useRef(false);
  const scrollKey = `scroll:${treeId}:${nodeId ?? "root"}`;
  useEffect(() => {
    let disposed = false,
      loading = false,
      dirty = false;
    let nextPoll = 0;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (disposed) return;
      if (loading) {
        dirty = true;
        return;
      }
      loading = true;
      try {
        const detail = await sdk.call("research.getTree", treeId);
        const path = conversationPath(detail, nodeId);
        const contents = await Promise.all(
          path.map((node) => sdk.call("research.getNodeContent", node.id)),
        );
        if (!disposed) {
          setData({ detail, contents });
          setLoadError("");
          nextPoll =
            Date.now() +
            (path.some((node) => isActiveResearchStatus(node.status))
              ? 3000
              : 30000);
        }
      } catch (error) {
        if (!disposed) setLoadError(String(error));
      } finally {
        loading = false;
        if (dirty && !disposed) {
          dirty = false;
          void refresh();
        }
      }
    };
    const schedule = () => {
      if (!debounce)
        debounce = setTimeout(() => {
          debounce = undefined;
          void refresh();
        }, 150);
    };
    refreshRef.current = () => {
      void refresh();
    };
    const unsubscribe = sdk.subscribe((name) => {
      if (name === "research.changed" || name === "reconnected") schedule();
    });
    void refresh();
    // Recover dropped events and keep running transcripts live without overlapping reads.
    const poll = setInterval(() => {
      if (!document.hidden && Date.now() >= nextPoll) void refresh();
    }, 3000);
    const focus = () => {
      if (!document.hidden) schedule();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    void sdk.call("research.markViewed", treeId).catch(() => {});
    return () => {
      disposed = true;
      clearInterval(poll);
      clearTimeout(debounce);
      unsubscribe();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [sdk, treeId, nodeId]);
  useEffect(() => {
    if (data && !restoredScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = Number(
        sdk.getSnapshot().viewState[scrollKey] ?? 0,
      );
      restoredScroll.current = true;
    }
  }, [data, sdk, scrollKey]);

  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      refreshRef.current();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const target = data?.contents[data.contents.length - 1]?.node;
  const archived = Boolean(data?.detail.tree.archivedAt);
  const fork = (inline: boolean) =>
    run(async () => {
      if (!target || !draft.trim()) return;
      const child = await sdk.call(
        "research.fork",
        target.id,
        draft.trim(),
        null,
        null,
        inline,
      );
      await sdk.call("viewState.save", draftKey, "");
      setDraft("");
      await sdk.call("navigation.go", researchRoute(treeId, child.id));
    });
  const openLink = (url: string) => {
    void sdk
      .call("ui.openExternalUrl", url)
      .catch((error) => setError(String(error)));
  };
  return (
    <div
      className="research-browser-conversation"
      ref={scrollRef}
      onScroll={(event) => {
        void sdk
          .call("viewState.save", scrollKey, event.currentTarget.scrollTop)
          .catch(() => {});
      }}
    >
      {error && (
        <div role="alert">
          {error}{" "}
          <button className="control-button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}
      {loadError && (
        <div role="alert">
          {loadError}{" "}
          <button
            className="control-button"
            onClick={() => refreshRef.current()}
          >
            Retry loading
          </button>
        </div>
      )}
      {!data ? (
        <p>Loading conversation…</p>
      ) : (
        <>
          <div className="research-browser-conversation-nav">
            <h1>{data.detail.tree.title}</h1>
            <label>
              Branch or turn{" "}
              <select
                value={target?.id ?? ""}
                onChange={(event) => {
                  void sdk
                    .call(
                      "navigation.go",
                      researchRoute(treeId, event.target.value),
                    )
                    .catch((error) => setError(String(error)));
                }}
              >
                {data.detail.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.title || node.prompt.slice(0, 80) || "Document"} ·{" "}
                    {node.status}
                  </option>
                ))}
              </select>
            </label>
            {target && (
              <button
                className="control-button"
                onClick={() => {
                  void run(() =>
                    sdk.call("navigation.openDocument", treeId, target.id),
                  );
                }}
              >
                Open in document view
              </button>
            )}
            {target?.paneId && (
              <button
                className="control-button"
                onClick={() => {
                  void run(() =>
                    sdk.call("navigation.openTerminal", target.paneId!),
                  );
                }}
              >
                Open terminal
              </button>
            )}
          </div>
          <TranscriptLinkActionsProvider
            actions={{ openLink, openLinkMenu: openLink }}
          >
            {data.contents.map((content) => (
              <article
                className="research-browser-segment"
                key={content.node.id}
              >
                <h2>
                  {content.node.title || content.node.prompt || "Document"}
                </h2>
                <p className="research-browser-meta">
                  {content.node.adapter} · {content.node.status}
                </p>
                {content.node.prompt && (
                  <TranscriptMarkdown text={content.node.prompt} />
                )}
                {content.node.error && <p role="alert">{content.node.error}</p>}
                {content.sourceError && (
                  <p role="alert">{content.sourceError}</p>
                )}
                {content.turns.map((turn) => (
                  <section key={turn.id} className="research-browser-turn">
                    <h3>{turn.role}</h3>
                    {turn.blocks.map((block, index) =>
                      block.type === "text" ? (
                        <TranscriptMarkdown key={index} text={block.text} />
                      ) : (
                        <details key={index}>
                          <summary>
                            {block.type === "toolUse"
                              ? block.name
                              : block.type === "toolResult"
                                ? "Tool result"
                                : "Trace"}
                          </summary>
                          <pre>{JSON.stringify(block, null, 2)}</pre>
                        </details>
                      ),
                    )}
                  </section>
                ))}
                {!content.turns.length && (
                  <p>
                    {isActiveResearchStatus(content.node.status)
                      ? "Waiting for the response…"
                      : "No response available."}
                  </p>
                )}
              </article>
            ))}
          </TranscriptLinkActionsProvider>
          {target && (
            <div className="research-browser-followup">
              {isActiveResearchStatus(target.status) && (
                <button
                  className="control-button"
                  disabled={busy}
                  onClick={() => {
                    void run(() => sdk.call("research.cancel", target.id));
                  }}
                >
                  Cancel run
                </button>
              )}
              {!archived && canRetryResearchNode(target) && (
                <button
                  className="control-button"
                  disabled={busy}
                  onClick={() => {
                    void run(() => sdk.call("research.retry", target.id));
                  }}
                >
                  Retry run
                </button>
              )}
              <label>
                Follow-up
                <textarea
                  value={draft}
                  placeholder="Ask a follow-up…"
                  rows={4}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraft(value);
                    void sdk
                      .call("viewState.save", draftKey, value)
                      .catch((error) => setError(String(error)));
                  }}
                />
              </label>
              <div className="research-browser-followup-actions">
                <button
                  className="control-button"
                  disabled={
                    busy ||
                    archived ||
                    !draft.trim() ||
                    !canFollowUpFrom(target)
                  }
                  onClick={() => {
                    void fork(false);
                  }}
                >
                  Fork branch
                </button>
                <button
                  className="control-button"
                  disabled={
                    busy ||
                    archived ||
                    !draft.trim() ||
                    !canContinueThread(data.detail.nodes, target)
                  }
                  onClick={() => {
                    void fork(true);
                  }}
                >
                  Continue inline
                </button>
              </div>
              {archived && (
                <p>
                  This research is archived. Restore it in qmux to add a
                  follow-up.
                </p>
              )}
              {!archived && !canFollowUpFrom(target) && (
                <p>
                  Follow-ups become available after a completed response has a
                  resumable session.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
