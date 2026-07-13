import { BookMarked, Ellipsis, Plus } from "lucide-react";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { deleteSavedPrompt, listSavedPrompts, saveSavedPrompt } from "../lib/api";
import { placePanePopover, turnPaneRectFrom } from "../lib/appHelpers";
import {
  discoverPlaceholders,
  fillPlaceholders,
  listenToSaveDraftAsPrompt,
} from "../lib/promptLibrary";
import type { PromptScope, SavedPrompt } from "../types";
import ConfirmDialogActionButton from "./ConfirmDialogActionButton";

const MENU_PREFERRED_WIDTH = 300;
const ROW_MENU_PREFERRED_WIDTH = 140;
// Custom MIME type so prompt rows only accept drops that started as prompt rows,
// never stray text/file drags from elsewhere.
const PROMPT_DRAG_TYPE = "application/x-qmux-prompt";
// Filenames are derived from the prompt's first line (prompts have no visible
// title); keep them comfortably shorter than the backend's 120-char limit.
const DERIVED_NAME_CHARS = 60;

// What the popover is currently showing: the searchable prompt list or the
// placeholder fill-in form for one prompt. Editing happens in a modal dialog.
type View =
  | { kind: "list" }
  | { kind: "fill"; prompt: SavedPrompt; placeholders: string[] };

// Centered modal dialogs, portaled above everything (including the popover,
// which stays open underneath so the list is fresh when the dialog closes).
type Dialog =
  | { kind: "editor"; original: SavedPrompt | null; lockedScope?: PromptScope }
  | { kind: "delete"; prompt: SavedPrompt };

interface PromptLibraryMenuProps {
  // Identifies the composer whose draft-save requests this menu handles.
  agentId?: string | null;
  // Inserts the chosen prompt text into the active composer at its caret.
  // Absent (e.g. a terminal pane with no agent) the trigger is disabled.
  onInsert?: (text: string) => void;
  // The active pane's project directory (group dir, or base repo for
  // worktrees). Keys the Project scope; absent hides that section.
  projectDir?: string | null;
  // Display form of projectDir (home-relative), shown under the Project heading.
  projectPath?: string | null;
}

/** First non-empty line of a prompt, for previews and dialog snippets. */
export function promptFirstLine(content: string): string {
  return content.trim().split("\n", 1)[0] || "(empty)";
}

// Prompts have no user-facing title, but each one is still a markdown file whose
// stem must be a valid, unique filename. Derive it from the first line of the
// content: strip characters the backend rejects, bound the length, and suffix a
// counter when the name is already taken in the target scope (case-insensitive,
// since macOS filesystems usually are).
function derivePromptName(content: string, takenNames: Iterable<string>): string {
  const firstLine = content.trim().split("\n", 1)[0] ?? "";
  const cleaned = Array.from(
    firstLine
      .replace(/[/\\:]/g, " ")
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, DERIVED_NAME_CHARS)
    .join("")
    .replace(/^[.\s]+/, "")
    .trim();
  const base = cleaned || "prompt";
  const taken = new Set(Array.from(takenNames, (name) => name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) {
    return base;
  }
  for (let counter = 2; ; counter += 1) {
    const candidate = `${base} ${counter}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

// The floating "…" menu on a prompt row, mirroring the message-title menu in the
// right sidebar: a single hover-revealed trigger that overlays the row (no layout
// shift) and opens a small portaled menu with Edit / Delete.
function PromptRowMenu({
  onEdit,
  onDelete,
}: {
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
    maxWidth: number;
  } | null>(null);

  const position = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) {
      return;
    }
    const { height } = popover.getBoundingClientRect();
    setPos(
      placePanePopover({
        triggerRect: trigger.getBoundingClientRect(),
        popoverSize: { width: ROW_MENU_PREFERRED_WIDTH, height },
        paneRect: turnPaneRectFrom(trigger),
        align: "end",
        prefer: "below",
      }),
    );
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    // Registered on window (which captures before document) so this Escape
    // closes only the row menu, not the prompt-library popover underneath —
    // its own capture listener sits on document and is stopped here.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    position();
    const onReflow = () => position();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, position]);

  const item = (label: string, action: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={`prompt-library-row-menu-item${danger ? " is-danger" : ""}`}
      onClick={() => {
        setOpen(false);
        action();
      }}
    >
      {label}
    </button>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`prompt-library-item-menu-trigger${open ? " is-open" : ""}`}
        title="Prompt options"
        aria-label="Prompt options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <Ellipsis size={14} aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="prompt-library-row-menu-popover"
              role="menu"
              aria-label="Prompt options"
              style={
                pos
                  ? {
                      left: pos.left,
                      top: pos.top,
                      maxHeight: pos.maxHeight,
                      width: Math.min(ROW_MENU_PREFERRED_WIDTH, pos.maxWidth),
                      maxWidth: pos.maxWidth,
                    }
                  : { left: -9999, top: -9999 }
              }
            >
              {item("Edit", onEdit)}
              {item("Delete", onDelete, true)}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// The pane header's saved-prompt library: a bookmark button opening a portaled
// popover with a searchable list of reusable messages, split into a Global
// section (~/.qmux/prompts/, visible everywhere) and a Project section keyed
// by the active pane's project directory (stored centrally under
// ~/.qmux/projects/, so repos stay clean). Prompts are titleless — each row is
// just the prompt text, and the backing filename is derived from its first
// line. Rows drag-and-drop between the sections to move a prompt's home.
// Editing, creating, and deleting happen in centered modal dialogs;
// `{placeholder}` slots discovered in a prompt's text get a fill-in step
// before insertion, Smithers-style.
export default function PromptLibraryMenu({
  agentId,
  onInsert,
  projectDir,
  projectPath,
}: PromptLibraryMenuProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // Null while the first load is in flight, so "No saved prompts" can't flash
  // before the list arrives.
  const [prompts, setPrompts] = useState<SavedPrompt[] | null>(null);
  const [hasProjectScope, setHasProjectScope] = useState(Boolean(projectDir));
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  // The scope section a prompt row is currently dragged over, for drop highlighting.
  const [dropScope, setDropScope] = useState<PromptScope | null>(null);
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  const [editContent, setEditContent] = useState("");
  const [editScope, setEditScope] = useState<PromptScope>("global");
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
    maxWidth: number;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const library = await listSavedPrompts(projectDir);
      setPrompts(library.prompts);
      setHasProjectScope(library.hasProjectScope);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectDir]);

  const openMenu = () => {
    setView({ kind: "list" });
    setSearch("");
    setError(null);
    setDropScope(null);
    setOpen(true);
    void refresh();
  };

  const openEditor = (original: SavedPrompt | null, scope?: PromptScope) => {
    setEditContent(original?.content ?? "");
    setEditScope(original?.scope ?? scope ?? "global");
    setDialogError(null);
    setDialog({ kind: "editor", original });
  };

  // Composer and sent-message menus can open the editor dialog with reusable
  // text. Composer drafts lock to Global; sent messages merely default there.
  useEffect(() => {
    if (!agentId) {
      return;
    }
    return listenToSaveDraftAsPrompt(agentId, (text, lockToGlobal) => {
      setEditContent(text);
      setEditScope("global");
      setDialogError(null);
      setDialog({
        kind: "editor",
        original: null,
        ...(lockToGlobal ? { lockedScope: "global" as const } : {}),
      });
      void refresh();
    });
  }, [agentId, refresh]);

  // A pane switch (e.g. ⌘1–9) can land on a different project while the popover
  // is open. The listed prompts would then belong to the old project while
  // save/delete target the new one — close instead, so the next open loads the
  // right store. Ref-compared so the effect only fires on a real project
  // change, not on open/close or unrelated re-renders.
  const openProjectDirRef = useRef(projectDir);
  useEffect(() => {
    if (openProjectDirRef.current !== projectDir) {
      openProjectDirRef.current = projectDir;
      setOpen(false);
      setDialog(null);
    }
  }, [projectDir]);

  // Close on an outside click. Escape steps back to the list from the fill view
  // (so half-typed values aren't lost to a reflexive Escape) and closes from the
  // list. Both handlers stand down while a modal dialog is up — the dialog owns
  // pointer and Escape handling then.
  useEffect(() => {
    if (!open || dialog) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // A row's "…" menu is portaled to the body, so its clicks would otherwise
      // read as outside the popover and close it before the menu item fires.
      if (target instanceof Element && target.closest(".prompt-library-row-menu-popover")) {
        return;
      }
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.stopPropagation();
      setView((current) => {
        if (current.kind === "list") {
          setOpen(false);
          return current;
        }
        return { kind: "list" };
      });
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, dialog]);

  // Dismissing a dialog (Escape, Save, Cancel) unmounts its focused editor
  // with no focusout, which would leave the app's editable-focus tracking
  // wedged true and the active terminal keyboard-dead — App's modal re-sample
  // backstop cannot see this component-local dialog. Hand focus somewhere
  // real so a focusin re-samples: the popover's search field when it is
  // still up, else the trigger that owns the whole flow. A project change is
  // different: the effect above closes stale UI while a pane switch is moving
  // focus to the new terminal, so never steal focus back in that case.
  const dialogWasOpenRef = useRef(false);
  const dialogProjectDirRef = useRef(projectDir);
  useEffect(() => {
    const wasOpen = dialogWasOpenRef.current;
    const isOpen = dialog !== null;
    dialogWasOpenRef.current = isOpen;
    if (!wasOpen && isOpen) {
      dialogProjectDirRef.current = projectDir;
      return;
    }
    if (!wasOpen || isOpen || dialogProjectDirRef.current !== projectDir) {
      return;
    }
    (searchInputRef.current ?? triggerRef.current)?.focus();
  }, [dialog, projectDir]);

  const position = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) {
      return;
    }
    const { height } = popover.getBoundingClientRect();
    setPos(
      placePanePopover({
        triggerRect: trigger.getBoundingClientRect(),
        popoverSize: { width: MENU_PREFERRED_WIDTH, height },
        paneRect: turnPaneRectFrom(trigger),
        align: "end",
        prefer: "below",
      }),
    );
  }, []);

  // Re-measure whenever the content that drives the popover's height changes
  // (view switches, search narrowing the list, prompts arriving).
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    position();
    const onReflow = () => position();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, position, view, prompts, search]);

  const insert = (text: string) => {
    onInsert?.(text);
    setOpen(false);
  };

  const choosePrompt = (prompt: SavedPrompt) => {
    const placeholders = discoverPlaceholders(prompt.content);
    if (placeholders.length === 0) {
      insert(prompt.content);
      return;
    }
    setFillValues({});
    setView({ kind: "fill", prompt, placeholders });
  };

  const namesInScope = (scope: PromptScope, excluding?: SavedPrompt) =>
    (prompts ?? [])
      .filter(
        (prompt) =>
          prompt.scope === scope &&
          !(excluding && prompt.scope === excluding.scope && prompt.name === excluding.name),
      )
      .map((prompt) => prompt.name);

  const saveEditor = async () => {
    if (dialog?.kind !== "editor" || busy || editContent.trim().length === 0) {
      return;
    }
    setBusy(true);
    try {
      const original = dialog.original;
      // A content edit that stays in its scope keeps its backing filename; a new
      // prompt (or one moving scopes) gets a fresh name derived from the content.
      const name =
        original && original.scope === editScope
          ? original.name
          : derivePromptName(editContent, namesInScope(editScope, original ?? undefined));
      await saveSavedPrompt(
        editScope,
        name,
        editContent,
        projectDir,
        original ? { scope: original.scope, name: original.name } : null,
      );
      await refresh();
      setDialog(null);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (dialog?.kind !== "delete" || busy) {
      return;
    }
    setBusy(true);
    try {
      await deleteSavedPrompt(dialog.prompt.scope, dialog.prompt.name, projectDir);
      await refresh();
      setDialog(null);
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const movePrompt = async (source: { scope: PromptScope; name: string }, target: PromptScope) => {
    if (busy || source.scope === target) {
      return;
    }
    const prompt = (prompts ?? []).find(
      (candidate) => candidate.scope === source.scope && candidate.name === source.name,
    );
    if (!prompt) {
      return;
    }
    setBusy(true);
    try {
      // Filenames are invisible now, so a name collision in the target scope is
      // resolved by deriving a fresh one instead of surfacing an error.
      const taken = namesInScope(target);
      const collides = taken.some((name) => name.toLowerCase() === prompt.name.toLowerCase());
      const name = collides ? derivePromptName(prompt.content, taken) : prompt.name;
      await saveSavedPrompt(target, name, prompt.content, projectDir, {
        scope: prompt.scope,
        name: prompt.name,
      });
      setError(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const query = search.trim().toLowerCase();
  const matchesQuery = (prompt: SavedPrompt) =>
    query.length === 0 || prompt.content.toLowerCase().includes(query);

  const sectionDropHandlers = (scope: PromptScope) => ({
    onDragOver: (event: DragEvent) => {
      if (event.dataTransfer.types.includes(PROMPT_DRAG_TYPE)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropScope(scope);
      }
    },
    onDragLeave: (event: DragEvent) => {
      // Only clear when leaving the section itself, not moving between its rows.
      if (!event.currentTarget.contains(event.relatedTarget as Node)) {
        setDropScope((current) => (current === scope ? null : current));
      }
    },
    onDrop: (event: DragEvent) => {
      const raw = event.dataTransfer.getData(PROMPT_DRAG_TYPE);
      setDropScope(null);
      if (!raw) {
        return;
      }
      event.preventDefault();
      try {
        const source = JSON.parse(raw) as { scope: PromptScope; name: string };
        void movePrompt(source, scope);
      } catch {
        // Malformed drag payloads are ignored.
      }
    },
  });

  const promptRow = (prompt: SavedPrompt) => (
    <div
      key={`${prompt.scope}:${prompt.name}`}
      className="prompt-library-item"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(
          PROMPT_DRAG_TYPE,
          JSON.stringify({ scope: prompt.scope, name: prompt.name }),
        );
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => setDropScope(null)}
    >
      <button
        type="button"
        role="menuitem"
        className="prompt-library-item-main"
        disabled={!onInsert}
        title={onInsert ? "Insert into composer" : "No composer in this tab"}
        onClick={() => choosePrompt(prompt)}
      >
        <span className="prompt-library-item-text">{prompt.content.trim() || "(empty)"}</span>
      </button>
      <PromptRowMenu
        onEdit={() => openEditor(prompt)}
        onDelete={() => {
          setDialogError(null);
          setDialog({ kind: "delete", prompt });
        }}
      />
    </div>
  );

  const section = (scope: PromptScope, label: string, pathHint?: string | null) => {
    const visible = (prompts ?? []).filter(
      (prompt) => prompt.scope === scope && matchesQuery(prompt),
    );
    // Mention drag-and-drop only when the other scope actually has something to
    // drag; an entirely empty library gets plain copy instead of a dead hint.
    const otherScopeHasPrompts = (prompts ?? []).some((prompt) => prompt.scope !== scope);
    return (
      <div
        className={`prompt-library-section${dropScope === scope ? " is-drop-target" : ""}`}
        role="group"
        aria-label={label}
        {...sectionDropHandlers(scope)}
      >
        <div className="prompt-library-section-header">
          <div className="prompt-library-section-heading">
            <span className="prompt-library-section-label">{label}</span>
            {pathHint ? (
              <span className="prompt-library-section-path" title={pathHint}>
                {pathHint}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="prompt-library-icon-button"
            title={`New ${label.toLowerCase()} prompt`}
            aria-label={`New ${label} prompt`}
            onClick={() => openEditor(null, scope)}
          >
            <Plus size={12} aria-hidden="true" />
          </button>
        </div>
        {prompts === null ? (
          <div className="prompt-library-empty">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="prompt-library-empty">
            {query.length > 0
              ? "No matches"
              : otherScopeHasPrompts
                ? "No prompts — drop one here"
                : "No prompts yet"}
          </div>
        ) : (
          visible.map(promptRow)
        )}
      </div>
    );
  };

  const listView = (
    <>
      <input
        ref={searchInputRef}
        type="text"
        className="prompt-library-search"
        placeholder="Search prompts…"
        value={search}
        autoFocus
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="prompt-library-list">
        {section("global", "Global")}
        {hasProjectScope ? (
          <>
            <div className="prompt-library-divider" role="separator" />
            {section("project", "Project", projectPath ?? projectDir)}
          </>
        ) : null}
      </div>
    </>
  );

  const fillView =
    view.kind === "fill" ? (
      <>
        <div className="prompt-library-kicker">Insert prompt</div>
        <div className="prompt-library-heading prompt-library-heading-snippet">
          {promptFirstLine(view.prompt.content)}
        </div>
        {view.placeholders.map((name, index) => (
          <label key={name} className="prompt-library-field">
            <span className="prompt-library-field-label">{name}</span>
            <input
              type="text"
              className="prompt-library-search"
              value={fillValues[name] ?? ""}
              autoFocus={index === 0}
              onChange={(event) =>
                setFillValues((current) => ({ ...current, [name]: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  insert(fillPlaceholders(view.prompt.content, fillValues));
                }
              }}
            />
          </label>
        ))}
        <div className="prompt-library-actions">
          <button
            type="button"
            className="prompt-library-button"
            onClick={() => setView({ kind: "list" })}
          >
            Back
          </button>
          <button
            type="button"
            className="prompt-library-button is-primary"
            onClick={() => insert(fillPlaceholders(view.prompt.content, fillValues))}
          >
            Insert
          </button>
        </div>
      </>
    ) : null;

  const closeDialog = () => {
    if (!busy) {
      setDialog(null);
    }
  };

  const editorDialog =
    dialog?.kind === "editor" ? (
      <div
        className="confirm-dialog prompt-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={dialog.original ? "Edit prompt" : "New prompt"}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeDialog();
          }
        }}
      >
        <h2>{dialog.original ? "Edit prompt" : "New prompt"}</h2>
        {hasProjectScope && !dialog.lockedScope ? (
          <div className="prompt-library-field">
            <span className="prompt-library-field-label">Saved in</span>
            <div className="prompt-library-scope-picker" role="radiogroup" aria-label="Saved in">
              {(
                [
                  ["global", "Global"],
                  ["project", "Project"],
                ] as const
              ).map(([scope, label]) => (
                <button
                  key={scope}
                  type="button"
                  role="radio"
                  aria-checked={editScope === scope}
                  className={`prompt-library-scope-option${
                    editScope === scope ? " is-active" : ""
                  }`}
                  title={scope === "project" ? (projectPath ?? projectDir ?? undefined) : undefined}
                  onClick={() => setEditScope(scope)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <label className="prompt-library-field">
          <span className="prompt-library-field-label">
            Prompt · use {"{placeholders}"} for fill-ins
          </span>
          <textarea
            className="prompt-library-editor prompt-editor-dialog-textarea"
            value={editContent}
            rows={8}
            autoFocus
            placeholder={"Review {target} for correctness bugs…"}
            onChange={(event) => setEditContent(event.target.value)}
          />
        </label>
        {dialogError ? <div className="prompt-library-error">{dialogError}</div> : null}
        <div className="confirm-dialog-actions">
          <button type="button" onClick={closeDialog}>
            Cancel
          </button>
          <ConfirmDialogActionButton
            pending={busy}
            pendingLabel="Saving…"
            disabled={editContent.trim().length === 0 || prompts === null}
            onClick={() => void saveEditor()}
          >
            Save
          </ConfirmDialogActionButton>
        </div>
      </div>
    ) : null;

  const deleteDialog =
    dialog?.kind === "delete" ? (
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Delete prompt"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeDialog();
          }
        }}
      >
        <h2>Delete prompt?</h2>
        <p className="prompt-delete-snippet">{dialog.prompt.content.trim() || "(empty)"}</p>
        {dialogError ? <div className="prompt-library-error">{dialogError}</div> : null}
        <div className="confirm-dialog-actions">
          <button type="button" onClick={closeDialog}>
            Cancel
          </button>
          <ConfirmDialogActionButton
            className="danger"
            autoFocus
            pending={busy}
            pendingLabel="Deleting…"
            onClick={() => void confirmDelete()}
          >
            Delete
          </ConfirmDialogActionButton>
        </div>
      </div>
    ) : null;

  return (
    <div className="prompt-library">
      <button
        ref={triggerRef}
        type="button"
        className={`turn-pane-header-button${open ? " is-active" : ""}`}
        title="Prompt library"
        aria-label="Prompt library"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <BookMarked size={14} aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              className="prompt-library-menu"
              role="menu"
              aria-label="Prompt library"
              style={
                pos
                  ? {
                      left: pos.left,
                      top: pos.top,
                      maxHeight: pos.maxHeight,
                      width: Math.min(MENU_PREFERRED_WIDTH, pos.maxWidth),
                      maxWidth: pos.maxWidth,
                    }
                  : { left: -9999, top: -9999 }
              }
            >
              {error ? <div className="prompt-library-error">{error}</div> : null}
              {view.kind === "list" ? listView : fillView}
            </div>,
            document.body,
          )
        : null}
      {dialog
        ? createPortal(
            <div
              className="confirm-dialog-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  closeDialog();
                }
              }}
            >
              {editorDialog}
              {deleteDialog}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
