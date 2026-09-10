import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import RecentActivityPane from "../components/research/JournalPane";
import { connectResearchBrowser, type ResearchBrowserSdk } from "./sdk";
import ConversationPage from "./ConversationPage";
import { researchRoute } from "./conversation";
import { setBrowserServices } from "./services";
import "../styles.css";
import "./view.css";

function ResearchBrowser({ sdk }: { sdk: ResearchBrowserSdk }) {
  const [snapshot, setSnapshot] = useState(sdk.getSnapshot);
  const [error, setError] = useState("");
  useEffect(() => {
    const stop = sdk.subscribe((name) => {
      if (name === "snapshot") setSnapshot(sdk.getSnapshot());
    });
    setSnapshot(sdk.getSnapshot());
    return stop;
  }, [sdk]);
  useEffect(() => {
    const root = document.documentElement;
    for (const attr of Array.from(root.attributes))
      if (attr.name.startsWith("data-")) root.removeAttribute(attr.name);
    for (const [name, value] of Object.entries(snapshot.theme.attributes))
      root.setAttribute(name, value);
    root.style.cssText = snapshot.theme.style;
  }, [snapshot.theme]);
  const routeParts = snapshot.route.split("/").map(decodeURIComponent);
  const run = (promise: Promise<unknown>) => {
    void promise.catch((error) => setError(String(error)));
  };
  return (
    <>
      {error && (
        <div role="alert" className="research-browser-error">
          {error}
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {routeParts[1] === "research" ? (
        <ConversationPage
          key={snapshot.route}
          sdk={sdk}
          treeId={routeParts[2]}
          nodeId={routeParts[4]}
        />
      ) : (
        <RecentActivityPane
          embedded
          {...snapshot.activity}
          initialScrollTop={Number(snapshot.viewState.activityScroll ?? 0)}
          onScrollChange={(top) => {
            if (top !== sdk.getSnapshot().viewState.activityScroll)
              run(sdk.call("viewState.save", "activityScroll", top));
          }}
          initialDraft={String(snapshot.viewState.activityDraft ?? "")}
          onDraftChange={(draft) => {
            if (draft !== sdk.getSnapshot().viewState.activityDraft)
              run(sdk.call("viewState.save", "activityDraft", draft));
          }}
          onAddEntry={(text) => run(sdk.call("journal.add", text))}
          onRemoveEntry={(id) => run(sdk.call("journal.remove", id))}
          onRetryTweet={(id) => run(sdk.call("journal.retry", id))}
          onUndoRemove={() => run(sdk.call("journal.undo"))}
          onDismissUndo={() => run(sdk.call("journal.dismissUndo"))}
          onLoadOlder={() => run(sdk.call("activity.loadOlder"))}
          onOpenResearchQuery={(query) =>
            run(
              sdk.call(
                "navigation.go",
                researchRoute(query.treeId, query.nodeId),
              ),
            )
          }
        />
      )}
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<p>Connecting to qmux…</p>);
void connectResearchBrowser()
  .then((sdk) => {
    setBrowserServices({
      openExternalUrl: (url) => sdk.call("ui.openExternalUrl", url),
      writeClipboardText: (text) => sdk.call("ui.writeClipboardText", text),
    });
    root.render(<ResearchBrowser sdk={sdk} />);
  })
  .catch((error) => root.render(<p role="alert">{String(error)}</p>));
