# Home

Home is the research launch surface and activity feed. It is a page on qmux's
**research surface only**, reached from the Home row at the top of the research
sidebar or with `Cmd-N`, and it replaces nothing in terminal mode: the
terminal map, `HomeRails`, `HomeGroupSelector` and `GlobalTaskLauncher` are
separate surfaces and behave exactly as before.

The page is one scroller: the query composer on top, then research queries,
saved links and X posts, newest first.

- Write a research prompt in the composer and pick its agent, model and effort.
  An unfinished draft survives navigation and reloads.
- Opening a research query opens its thread in the document view, which owns
  follow-ups, branching, retry/cancel, highlights and the rest of the research
  controls. Back returns to Home with its draft and scroll position intact.
- Each research card ends with Follow and Bookmark beside its timestamp. Both
  are stored on the thread, and the open thread shows the same pair under its
  root prompt.
- The Bookmarks row below Home shows the same feed limited to bookmarked
  threads, without the composer or the setup guide.
- The Highlights row below Bookmarks lists every highlight saved in open
  threads, newest first under day headers, each passage shown inside its stored
  context. Opening one selects its thread and scrolls to the passage; the
  request is recorded under `qmux.research-navigation.v1` and cleared once the
  document lands on it.
- The Encyclopedia section between the journal rows and the research list holds
  pages grown from wikilinks. Clicking (or focusing and pressing Enter or Space
  on) a `[[Term]]` in an answer opens the term's page, creating it on first
  click: the surrounding block, the other linked terms in that block, and the
  thread's question are sent to the model so it writes about the sense the
  answer meant. Pages are stored per research folder under
  `encyclopedia-v1/` inside the workspace state directory, list the passages
  that mention them under "Mentioned in", and link onward to other pages through
  their own wikilinks. The page header offers Rewrite and Delete. An OpenRouter
  key in Settings writes pages through OpenRouter; without one they are written
  by the answering agent.
- `Ctrl-Tab` and `Shift-Ctrl-Tab` step through Home, Bookmarks and Highlights,
  then the scoped encyclopedia pages, then the scoped research threads, then the
  visible research terminals, wrapping both ways. `Cmd-1` through `Cmd-9` stay
  assigned to threads only.
- A card's context menu renames, archives or restores, deletes, stars, and
  groups a thread into a folder — the same actions as its sidebar row.
- The feed's header menu ("Feed actions") holds Refresh and
  "Add link or note…", which classifies what you paste or type: an X post URL
  is hydrated into a card, another URL becomes a link entry, anything else is
  saved as a note.
- An entry's own menu opens or copies its link (or copies a note's text),
  refreshes or retries a post whose hydration failed, and deletes the entry.
  A deletion leaves an "Entry removed"/"Note removed" bar with Undo until it is
  dismissed.
- New activity arrives live. While scrolled away from the top, a new-activity
  button returns to the newest items. Older pages load as the end approaches,
  with a manual "Load older" / "Retry" control when a page fails. Refresh
  refetches the head of the feed.
- Back and Forward in the header, `Cmd/Ctrl-[` and `Cmd/Ctrl-]`, Alt-Left and
  Alt-Right, the mouse history buttons (3 and 4) and a two-finger horizontal
  swipe all move through the same workspace history as a research document:
  Home is a peer page of a document, not an overlay on one. Trees that are
  archived or deleted are pruned from that history, so Back never opens a page
  that no longer exists, and each page starts at its own scroll position rather
  than inheriting the outgoing page's offset.

The feed renders directly in the application: no iframe, no embedded browser and
no separate development server. Use `npm run dev` for development and
`npm run test:unit` for the feed, pagination, swipe and state-restoration
coverage. The feed's scroll anchor is stored under
`qmux.research-activity.state.v1`; a missing or unreadable value opens the
feed at the top.
