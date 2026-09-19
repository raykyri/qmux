# CSS conventions

qmux uses global CSS with cascade layers. The application imports one entrypoint,
`src/styles.css`, in this order:

1. `tokens` defines fonts, type and control scales, semantic colors, themes, and shared
   stacking levels.
2. `base` normalizes elements and defines the default `.control-button`.
3. `primitives` contains context-independent UI building blocks such as icon buttons,
   menu rows, popover surfaces, fields, and shortcut hints.
4. `components` contains complete reusable component stylesheets — `components/dialog.css`,
   `components/select.css` — that belong to a shared component in `src/components/ui`.
5. `features` contains page and feature rules. Files in this layer still follow import
   order, so a later feature file must not silently redefine an earlier feature's base
   geometry.

## Ownership

- Put a value in `tokens.css` when its semantic role is shared or theme-dependent.
- Put a rule in `base.css` only when it applies to native elements or the entire app.
- Put a reusable, context-independent control in `primitives.css`.
- Put a complete reusable component's stylesheet in `styles/components/`.
- Put shared Home/research page chrome, reading typography, and content-card recipes in
  `features/research-surface.css`.
- Keep research-thread and research-sidebar details in `features/research.css`, Home feed
  details in `features/journal.css`, and outer application/terminal/sidebar layout in
  `features/shell.css`.

Feature styles should not rely on an unrelated file loading later to complete or correct
their layout. When two destinations share a visual contract, give that contract a shared
class instead of copying its declarations.

`AGENTS.md` is the authority for the markup side of this split: check `src/components/ui`,
`src/styles/primitives.css` and `src/styles/components` before building a button, field,
menu, popover, dialog or select, use `useListbox` and `useAnchoredPopover` instead of new
document listeners or placement effects, and cover new shared variants and states in the
development component catalog at `?ui-catalog=1`.

## Naming and composition

- Use kebab-case classes with a feature prefix: `.research-prompt`, `.journal-entry`.
- Express state with `.is-*` and `.has-*`: `.is-selected`, `.has-open-menu`.
- Compose a primitive or shared recipe with a feature class in markup; do not restyle bare
  elements when the behavior is local to one component.
- Keep selector specificity low. Prefer one feature class plus an optional state over deep
  descendant chains.
- Use CSS custom properties for a component's local scale or geometry when descendants
  need the same value.

## Tokens and type

Use semantic tokens (`--text-*`, `--surface-*`, `--control-*`, `--status-*`) before adding
literal colors. Literal colors are appropriate for external brand colors or documented
browser limitations, and should carry a comment when the reason is not obvious.

Home and research threads are one reading surface. Their main content roots must include
`.research-reading-surface`. Primary Markdown uses `.research-prose`, derived summaries use
`.research-summary-text`, and authored user messages use the unboxed `ResearchUserMessage`
primitive. Destination styles may position those components, but must not override their
font metrics. Compact previews and annotations must select an explicit prose variant so
moving content does not change its type scale or rhythm.

## Responsive and accessibility behavior

- Keep page scrolling vertical. Tables, code, and other wide content own their horizontal
  scrolling.
- Add narrow-layout behavior beside the feature rules it changes.
- Preserve visible `:focus-visible` states and semantic disabled states.
- Put global motion overrides in `reduced-motion.css`; progress indicators may continue to
  animate when motion communicates active work.

## Review checklist

- Verify new colors in every supported `data-color-theme`.
- Check Home, an individual research thread, and the collapsed/expanded sidebar.
- Check the thread layout above and below its responsive breakpoint.
- Search for removed class names across TypeScript, JSX, tests, and CSS before deleting or
  retaining selectors.
- Run `npx tsc --noEmit -p tsconfig.json` and `npm run test:unit`. CSS has no standalone
  linter, so review the computed cascade when selectors span feature files.
