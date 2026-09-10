# Research Browser templates (SDK v1)

Research Browser replaces the Recent Activity tab. qmux owns its header, sidebar,
data, research runs, and journal undo. The iframe owns the activity/conversation
pages below that header. Editing or reloading the iframe leaves native runs alive.

## Iterate against your installed app

The installed application needs a build containing the Research Browser host once.
After that, frontend template changes do not require rebuilding qmux:

```sh
npm install
npm run dev:research-browser
```

In qmux, open **Research Browser → View source**, enter
`http://127.0.0.1:1421/research-browser.html`, and click **Load view**. Edit
`src/research-browser/ConversationPage.tsx`, `src/research-browser/view.css`, or the
reused activity body in `src/components/research/JournalPane.tsx`. Vite applies React
and CSS updates. Its error overlay reports compile errors; fix the source to resume.

Serve your own directory instead:

```sh
npm run dev:research-browser -- /absolute/path/to/my-view
# Or try the included plain HTML example:
npm run dev:research-browser -- examples/research-browser
```

Load `http://127.0.0.1:1421/` for an `index.html`, or append your HTML filename.
HTML, JS, CSS, TypeScript, and TSX are supported by the local Vite server. React and
React DOM are resolved from qmux's dependencies, so a small template needs no
separate package installation. JSX files should use `.tsx` or `.jsx` extensions.
The server must stay running for external views. The bundled view works offline;
**Restore built-in view** remains in the parent header even if a template fails.
The external source URL persists in local settings. Blank source selects the bundle.

## Trust and lifetime

Loading a URL explicitly trusts that local application's code with read/write
research access. It is application code, not an untrusted document preview. The
host accepts only HTTP loopback URLs and attaches the SDK to the selected iframe,
origin, path, and query string. Hash changes are internal navigation. Navigating
to another document closes the connection; the SDK reconnects only when its
reported entry URL matches. The selected origin/project is the trust boundary;
same-origin scripts are not isolated from one another. Keep ordinary links in the
external browser using the SDK.

The bridge uses a versioned handshake and a private MessageChannel, with an explicit
method allowlist. It does not expose arbitrary native `invoke`, file reads, or SQL.
Data operations use existing backend validation, revision checks, events, and runs.
Never call Tauri directly from a template. Changes requiring new native operations
still require a qmux update.

Routes, drafts, and scroll state are stored by the parent for this app session and
survive iframe reloads and switching away from the tab. Back/Forward in the parent
header traverses the mini-app's route stack, then the existing workspace history
at its boundaries. The bundled view uses `/activity`, `/research/:treeId`, and
`/research/:treeId/node/:nodeId`. The tree landing shows the root's inline thread;
a node route shows its complete ancestry. Call `navigation.go` for routing.

## SDK

With the provided server, use either import:

```ts
import { connectResearchBrowser } from "@qmux/research-browser";
// Plain HTML module scripts can import from "/@qmux/sdk".

const qmux = await connectResearchBrowser();
const snapshot = qmux.getSnapshot();
const trees = await qmux.call("research.list", true); // include archived
const detail = await qmux.call("research.getTree", trees[0].id);
const content = await qmux.call("research.getNodeContent", detail.tree.rootNodeId);
// content: { node, turns, children, sourceError?, responseRevision? }
// Each turn includes its role and ordered text/tool blocks.

const child = await qmux.call(
  "research.fork", content.node.id, "Explore an alternative", null, null, false,
);
await qmux.call("navigation.go", `/research/${child.treeId}/node/${child.id}`);
```

The authoritative typed contract is `src/research-browser/protocol.ts`. Arguments
and return types retain existing backend API signatures:

| Group | Methods |
| --- | --- |
| Workspaces | `workspaces.list()` returns research workspaces; `workspaces.ensureDefault()` creates/returns the default workspace |
| Discovery | `research.list(includeArchived?)`, `research.activity(limit?, cursor?)`, `research.folders()` |
| Read | `research.getTree(treeId)`, `research.getNodeContent(nodeId)` |
| Create | `research.create(request)`, `research.createDocument(request)` |
| Run | `research.fork(parentNodeId, prompt, publicationProposal?, queryAnchor?, inline?)`, `research.retry(nodeId)`, `research.cancel(nodeId)` |
| Edit | `research.renameTree(treeId, title)`, `research.renameNode(nodeId, title)`, `research.updateDocument(request)` |
| Highlights | `research.createHighlight(nodeId, anchor)`, `research.removeHighlight(nodeId, highlightId)` |
| Attention | `research.markViewed(treeId)` |
| Journal | `journal.add(text)`, `journal.remove(id)`, `journal.retry(id)`, `journal.undo()`, `journal.dismissUndo()` |
| Feed | `activity.loadOlder()` uses the parent's reconciled pagination |
| Navigation | `navigation.go(route)`, `navigation.back()`, `navigation.forward()`, `navigation.openDocument(treeId, nodeId)`, `navigation.openTerminal(paneId)` |
| Native UI | `ui.openExternalUrl(url)`, `ui.writeClipboardText(text)`, `ui.reportError(message)` |
| Session state | `viewState.save(key, value)` stores structured-cloneable data |

`research.updateDocument` requires `nodeId`, `markdown`, `expectedResponseRevision`,
`expectedTitle`, and `expectedHighlightIds` (plus optional `title`). Never drop these
checks when editing a document; on conflict refetch and let the user reconcile.

Journal calls acknowledge dispatch to the existing parent callbacks; their durable
outcome arrives in the next activity snapshot or the parent's error UI. Backend
research calls resolve with their service results. RPC failures are
`BrowserRpcError` objects with `code`, `message`, and optional native `details`.
Calls time out after 60 seconds. A timed-out write may have completed: refresh before
retrying. Writes are never automatically replayed after disconnect or timeout.

```ts
const stop = qmux.subscribe((name, value) => {
  if (name === "snapshot") {
    const { activity, route, viewState, theme } = qmux.getSnapshot();
    // Render the latest parent activity state, route, or restored view state.
  }
  if (name === "research.changed" || name === "reconnected") {
    // Refetch the visible tree/content. Events are invalidations, not a database.
  }
});
// Stop when the subscribing component unmounts.
stop();

await qmux.call("viewState.save", "my-draft", "Remember this text");
```

Subscribe before reading `getSnapshot()` to avoid a read/subscribe race. Initial
state is available when the connection resolves. The bundled conversation page
subscribes before fetching, serializes refreshes, and periodically refetches to
recover missed events and read streaming content. Custom templates should follow
that pattern. Theme snapshots include the parent's data attributes and inline
CSS variables; the bundled template imports qmux's styles as well.

The SDK forwards recognized application shortcuts from the iframe to the existing
parent dispatcher, preserving ordinary text-editing chords. It also forwards
Back/Forward shortcuts. No new app-level chord is introduced.
