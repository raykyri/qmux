import { BookMarked, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  deleteSavedPrompt,
  listSavedPrompts,
  revealSavedPrompts,
  saveSavedPrompt,
} from "../lib/api";
import { placePanePopover, turnPaneRectFrom } from "../lib/appHelpers";
import {
  discoverPlaceholders,
  fillPlaceholders,
  listenToSaveDraftAsPrompt,
} from "../lib/promptLibrary";
import type { PromptScope, SavedPrompt } from "../types";

const MENU_PREFERRED_WIDTH = 300;
// Custom MIME type so prompt rows only accept drops that started as prompt rows,
// never stray text/file drags from elsewhere.
const PROMPT_DRAG_TYPE = "application/x-qmux-prompt";

// What the popover is currently showing: the searchable prompt list, the
// placeholder fill-in form for one prompt, or the new/edit prompt editor.
type View =
  | { kind: "list" }
  | { kind: "fill"; prompt: SavedPrompt; placeholders: string[] }
  | { kind: "edit"; original: SavedPrompt | null; lockedScope?: PromptScope };

interface PromptLibraryMenuProps {
  // Identifies the composer whose draft-save requests this menu handles.
  agentId?: string | null;
  // Inserts the chosen prompt text into the active composer at its caret.
  // Absent (e.g. a terminal pane with no agent) the trigger is disabled.
  onInsert?: (text: string) => void;
  // The active pane's project directory (group dir, or base repo for
  // worktrees). Keys the Project scope; absent hides that section.
  projectDir?: string | null;
  // Human label for the project section, e.g. the group name.
  projectLabel?: string | null;
}

// The pane header's saved-prompt library: a bookmark button opening a portaled
// popover with a searchable list of reusable messages, split into a Global
// section (~/.qmux/prompts/, visible everywhere) and a Project section keyed
// by the active pane's project directory (stored centrally under
// ~/.qmux/projects/, so repos stay clean). Rows drag-and-drop between the
// sections to move a prompt's home. `{placeholder}` slots discovered in a
// prompt's text get a fill-in step before insertion, Smithers-style.
export default function PromptLibraryMenu({
  agentId,
  onInsert,
  projectDir,
  projectLabel,
}: PromptLibraryMenuProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: "list" });
  // Null while the first load is in flight, so "No saved prompts" can't flash
  // before the list arrives.
  const [prompts, setPrompts] = useState<SavedPrompt[] | null>(null);
  const [hasProjectScope, setHasProjectScope] = useState(Boolean(projectDir));
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Two-step delete: the first click arms this prompt's button, the second deletes.
  const [deleteArmed, setDeleteArmed] = useState<SavedPrompt | null>(null);
  // The scope section a prompt row is currently dragged over, for drop highlighting.
  const [dropScope, setDropScope] = useState<PromptScope | null>(null);
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editScope, setEditScope] = useState<PromptScope>("global");
  const [busy, setBusy] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
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
    setDeleteArmed(null);
    setDropScope(null);
    setOpen(true);
    void refresh();
  };

  // Composer and sent-message menus can open this editor with reusable text.
  // Composer drafts lock to Global; sent messages merely default there.
  useEffect(() => {
    if (!agentId) {
      return;
    }
    return listenToSaveDraftAsPrompt(agentId, (text, lockToGlobal) => {
      setOpen(true);
      setSearch("");
      setError(null);
      setDeleteArmed(null);
      setDropScope(null);
      setEditName("");
      setEditContent(text);
      setEditScope("global");
      setView({
        kind: "edit",
        original: null,
        ...(lockToGlobal ? { lockedScope: "global" as const } : {}),
      });
      void refresh();
    });
  }, [agentId, refresh]);

  // A pane switch (e.g. ⌘1–9) can land on a different project while the popover
  // is open. The listed prompts would then belong to the old project while
  // save/delete/reveal target the new one — close instead, so the next open
  // loads the right store. Ref-compared so the effect only fires on a real
  // project change, not on open/close or unrelated re-renders.
  const openProjectDirRef = useRef(projectDir);
  useEffect(() => {
    if (openProjectDirRef.current !== projectDir) {
      openProjectDirRef.current = projectDir;
      setOpen(false);
    }
  }, [projectDir]);

  // Close on an outside click. Escape steps back to the list from a subview
  // (so a half-typed prompt isn't lost to a reflexive Escape) and closes from it.
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
  }, [open]);

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

  const startEdit = (original: SavedPrompt | null, scope?: PromptScope) => {
    setEditName(original?.name ?? "");
    setEditContent(original?.content ?? "");
    setEditScope(original?.scope ?? scope ?? "global");
    setError(null);
    setView({ kind: "edit", original });
  };

  const saveEdit = async () => {
    if (view.kind !== "edit" || busy) {
      return;
    }
    setBusy(true);
    try {
      await saveSavedPrompt(
        editScope,
        editName,
        editContent,
        projectDir,
        view.original ? { scope: view.original.scope, name: view.original.name } : null,
      );
      await refresh();
      setView({ kind: "list" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removePrompt = async (prompt: SavedPrompt) => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await deleteSavedPrompt(prompt.scope, prompt.name, projectDir);
      setDeleteArmed(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    // A same-named prompt in the target scope would be silently overwritten by
    // the move; surface it instead and let the user rename first.
    if ((prompts ?? []).some((other) => other.scope === target && other.name === prompt.name)) {
      setError(`"${prompt.name}" already exists in ${target === "global" ? "Global" : "Project"}`);
      return;
    }
    setBusy(true);
    try {
      await saveSavedPrompt(target, prompt.name, prompt.content, projectDir, {
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

  // Prefer the caller's label (group name); fall back to the directory's
  // basename so the section always names a concrete place.
  const projectSectionName =
    projectLabel?.trim() ||
    projectDir?.replace(/\/+$/, "").split("/").pop() ||
    null;

  const query = search.trim().toLowerCase();
  const matchesQuery = (prompt: SavedPrompt) =>
    query.length === 0 ||
    prompt.name.toLowerCase().includes(query) ||
    prompt.content.toLowerCase().includes(query);

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
        <span className="prompt-library-item-name">{prompt.name}</span>
        <span className="prompt-library-item-preview">
          {prompt.content.trim().split("\n", 1)[0] || "(empty)"}
        </span>
      </button>
      <div className="prompt-library-item-actions">
        <button
          type="button"
          className="prompt-library-icon-button"
          title="Edit prompt"
          aria-label={`Edit ${prompt.name}`}
          onClick={() => startEdit(prompt)}
        >
          <Pencil size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`prompt-library-icon-button${
            deleteArmed?.scope === prompt.scope && deleteArmed?.name === prompt.name
              ? " is-danger"
              : ""
          }`}
          title={
            deleteArmed?.scope === prompt.scope && deleteArmed?.name === prompt.name
              ? "Click again to delete"
              : "Delete prompt"
          }
          aria-label={`Delete ${prompt.name}`}
          onClick={() => {
            if (deleteArmed?.scope === prompt.scope && deleteArmed?.name === prompt.name) {
              void removePrompt(prompt);
            } else {
              setDeleteArmed(prompt);
            }
          }}
        >
          <Trash2 size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );

  const section = (scope: PromptScope, label: string) => {
    const visible = (prompts ?? []).filter(
      (prompt) => prompt.scope === scope && matchesQuery(prompt),
    );
    return (
      <div
        className={`prompt-library-section${dropScope === scope ? " is-drop-target" : ""}`}
        role="group"
        aria-label={label}
        {...sectionDropHandlers(scope)}
      >
        <div className="prompt-library-section-header">
          <span className="prompt-library-section-label">{label}</span>
          <button
            type="button"
            className="prompt-library-icon-button"
            title={`Open ${label.toLowerCase()} prompts folder`}
            aria-label={`Open ${label} prompts folder`}
            onClick={() => {
              setOpen(false);
              void revealSavedPrompts(scope, projectDir).catch(() => undefined);
            }}
          >
            <FolderOpen size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="prompt-library-icon-button is-always-visible"
            title={`New ${label.toLowerCase()} prompt`}
            aria-label={`New ${label} prompt`}
            onClick={() => startEdit(null, scope)}
          >
            <Plus size={12} aria-hidden="true" />
          </button>
        </div>
        {prompts === null ? (
          <div className="prompt-library-empty">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="prompt-library-empty">
            {query.length > 0 ? "No matches" : "No prompts — drop one here"}
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
        type="text"
        className="prompt-library-search"
        placeholder="Search prompts…"
        value={search}
        autoFocus
        onChange={(event) => {
          setSearch(event.target.value);
          setDeleteArmed(null);
        }}
      />
      <div className="prompt-library-list">
        {section("global", "Global")}
        {hasProjectScope
          ? section("project", projectSectionName ? `Project · ${projectSectionName}` : "Project")
          : null}
      </div>
    </>
  );

  const fillView =
    view.kind === "fill" ? (
      <>
        <div className="prompt-library-heading">{view.prompt.name}</div>
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

  const editView =
    view.kind === "edit" ? (
      <>
        <div className="prompt-library-heading">
          {view.original ? "Edit prompt" : "New prompt"}
        </div>
        <label className="prompt-library-field">
          <span className="prompt-library-field-label">Name</span>
          <input
            type="text"
            className="prompt-library-search"
            value={editName}
            autoFocus={!view.original}
            placeholder="e.g. Review checklist"
            onChange={(event) => setEditName(event.target.value)}
          />
        </label>
        {hasProjectScope && !view.lockedScope ? (
          <div className="prompt-library-field">
            <span className="prompt-library-field-label">Saved in</span>
            <div className="prompt-library-scope-picker" role="radiogroup" aria-label="Saved in">
              {(
                [
                  ["global", "Global"],
                  ["project", projectSectionName ? `Project · ${projectSectionName}` : "Project"],
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
                  onClick={() => setEditScope(scope)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : view.lockedScope ? (
          <div className="prompt-library-field">
            <span className="prompt-library-field-label">Saved in</span>
            <div>Global</div>
          </div>
        ) : null}
        <label className="prompt-library-field">
          <span className="prompt-library-field-label">
            Prompt · use {"{placeholders}"} for fill-ins
          </span>
          <textarea
            className="prompt-library-editor"
            value={editContent}
            rows={6}
            placeholder={"Review {target} for correctness bugs…"}
            onChange={(event) => setEditContent(event.target.value)}
          />
        </label>
        <div className="prompt-library-actions">
          <button
            type="button"
            className="prompt-library-button"
            onClick={() => setView({ kind: "list" })}
          >
            Cancel
          </button>
          <button
            type="button"
            className="prompt-library-button is-primary"
            disabled={busy || editName.trim().length === 0 || editContent.trim().length === 0}
            onClick={() => void saveEdit()}
          >
            Save
          </button>
        </div>
      </>
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
              {view.kind === "list" ? listView : view.kind === "fill" ? fillView : editView}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
