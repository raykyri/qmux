# Tab nesting (indentation) in the sidebar

Lets sidebar tabs (panes) be nested under one another to form an outline/tree.
Two ways to indent: drag a tab onto another tab, or use Indent/Outdent buttons in
a tab's context menu.

## Data model

Each pane gains a `depth: u16` (0 = root). The tree is *implicit* from the existing
pane order plus depth — a flattened outline, the same shape org-mode/Workflowy use:

- A pane's **parent** is the nearest preceding pane with `depth == thisDepth - 1`.
- A pane's **subtree** is the contiguous run of following panes with `depth > thisDepth`.

**Validity invariant** for the ordered list:

- The first pane has depth 0.
- Every pane's depth ≤ the previous pane's depth + 1 (you can't skip a level).
- `0 ≤ depth ≤ MAX_DEPTH` (8).

Source of truth lives in the backend: `Model.pane_depth: HashMap<paneId, u16>`.
`ordered_panes` stamps `depth` onto each returned `PaneInfo`. Depth is persisted
within each `PaneInfo` (serde `default = 0` for back-compat) and re-hydrated into
`pane_depth` on restore, then normalized.

## Backend

- **`pane_set_layout(items: [{ paneId, depth }])`** — the single atomic mutation for
  tab structure. Validates that `items` cover exactly the current panes (no missing,
  duplicate, or unknown id) and form a valid tree, then replaces `pane_order` and
  `pane_depth` under one lock and persists. Returns the ordered panes. Rejects a
  stale/invalid layout (the frontend refetches). All operations (reorder, indent,
  outdent, nest) are expressed as a new layout and applied through this one call, so
  an indent that changes several panes is applied atomically.
- **`normalize_pane_depths`** — clamps depths to the invariant along the effective
  order and drops stale ids. Run after a pane is removed and on restore. This is what
  promotes orphaned children when their parent tab is closed (the children clamp up
  one level instead of leaving an invalid gap).
- New panes are appended at depth 0.

`reorder_panes` remains for depth-agnostic callers/tests but the frontend now routes
all tab moves through `pane_set_layout`.

## Frontend tree ops — pure, `src/lib/paneTree.ts`

Operate on `panes: PaneInfo[]` (ordered, each with `depth`) and return a new ordered
array; callers send `{ id, depth }[]` to `pane_set_layout`.

- `subtreeEnd(panes, i)` — first `j > i` with `depth ≤ depth[i]`, else `panes.length`.
- `canIndent(panes, i)` — `i > 0 && depth[i] ≤ depth[i-1] && depth[i] < MAX_DEPTH`.
- `canOutdent(panes, i)` — `depth[i] > 0`.
- `indent(panes, i)` / `outdent(panes, i)` — shift the subtree `[i, end)` by `+1` / `-1`.
- `nestUnder(panes, dragId, targetId)` — if the target is not inside the dragged
  subtree and `target !== drag`: move the dragged subtree to immediately after the
  target (first child), with root depth `targetDepth + 1`; the same delta is applied
  to the rest of the subtree. No-op if it would exceed `MAX_DEPTH`.
- `moveToGap(panes, dragId, gapIndex)` — move the dragged subtree to the gap; the
  root's new depth is the depth of the row that ends up directly below the gap (so a
  drop becomes a sibling of the row below it), else the row above, else 0; clamped to
  the invariant.

## Drag interaction

While dragging, for a tab row of height `H` that is **not** part of the dragged
subtree:

- pointer in the top ~30% → reorder gap **above** (accent line above).
- pointer in the bottom ~30% → reorder gap **below** (accent line below).
- pointer in the middle ~40% → **nest into** this row.

Dragging always moves the grabbed tab's whole subtree. Rows inside the dragged
subtree are never drop targets (you can't nest a tab into itself or a descendant).

## Drop indicators

- **Reorder (gap):** the existing accent line at the row's top/bottom
  (`is-drop-before` / `is-drop-after`).
- **Nest:** an overlay on the target row — a solid rounded rectangle whose left edge
  is inset from the row's left by one indent step; a dashed border fills the remaining
  left gutter (`0 .. indent`); a `→` arrow is centered in that gutter. This shows the
  child's left edge landing one level in, with the dotted gutter marking the space it
  is moving past. (`.pane-tab-nest-indicator`)

## Rendering

Each row indents its text content by `depth × --pane-indent` (a CSS var) while the
full-width selection highlight, status indicator, and close affordance keep fixed
left columns.

## Context menu

Add **Indent** and **Outdent** buttons. Indent is disabled unless `canIndent`,
Outdent unless `canOutdent` (so Outdent is disabled at the root level and Indent is
disabled when there's no eligible tab above). Clicking applies the op through
`pane_set_layout` with the same optimistic-update + request-sequence guard the reorder
path uses. The menu stays open after an action so the disabled states update live and
the user can chain indents.

## Persistence / recovery

`depth` round-trips through the persisted `PaneInfo` list and is normalized on restore,
so a parent pane that was finished (not respawned) before a restart cannot leave its
former children at an invalid depth.

## Decisions (sensible defaults, easy to change)

- Nesting places the dragged tab as the **first** child (immediately after the target).
- A gap drop makes the tab a **sibling of the row below** the drop point.
- `MAX_DEPTH = 8`.
