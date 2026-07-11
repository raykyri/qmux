import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

// One runnable entry in the ⌘K palette. Commands are grouped by section in the
// order sections first appear in the array.
export interface PaletteCommand {
  id: string;
  section: string;
  title: string;
  // Right-aligned detail: a shortcut label, group name, or content preview.
  hint?: string;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}

// The ⌘K command palette: a centered modal with a filter input over navigation,
// action, and saved-prompt commands. Arrow keys move the selection across section
// boundaries; Enter runs it; Escape or a backdrop click closes.
export default function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      return commands;
    }
    return commands.filter(
      (command) =>
        command.title.toLowerCase().includes(needle) ||
        command.section.toLowerCase().includes(needle) ||
        (command.hint ?? "").toLowerCase().includes(needle),
    );
  }, [commands, query]);

  // A fresh open or a narrowed list restarts the selection at the top.
  useEffect(() => {
    setSelectedIndex(0);
  }, [open, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Keep the keyboard selection visible while arrowing through a long list.
  useEffect(() => {
    if (!open) {
      return;
    }
    listRef.current
      ?.querySelector(`[data-palette-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, selectedIndex]);

  if (!open) {
    return null;
  }

  const run = (command: PaletteCommand) => {
    onClose();
    command.action();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length === 0) {
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex((current) => (current + step + filtered.length) % filtered.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const command = filtered[selectedIndex];
      if (command) {
        run(command);
      }
    }
  };

  // Rows render flat (so index-based selection stays simple) with a section
  // label injected above each row that starts a new section.
  let previousSection: string | null = null;

  return (
    <div
      className="command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          type="text"
          className="command-palette-input"
          placeholder="Type a command or search…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="command-palette-list" ref={listRef} role="listbox">
          {filtered.length === 0 ? (
            <div className="command-palette-empty">No matching commands</div>
          ) : (
            filtered.map((command, index) => {
              const sectionLabel =
                command.section !== previousSection ? (
                  <div key={`section:${command.section}`} className="command-palette-section">
                    {command.section}
                  </div>
                ) : null;
              previousSection = command.section;
              return (
                <div key={command.id}>
                  {sectionLabel}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === selectedIndex}
                    data-palette-index={index}
                    className={`command-palette-item${
                      index === selectedIndex ? " is-selected" : ""
                    }`}
                    onMouseMove={() => setSelectedIndex(index)}
                    onClick={() => run(command)}
                  >
                    <span className="command-palette-item-title">{command.title}</span>
                    {command.hint ? (
                      <span className="command-palette-item-hint">{command.hint}</span>
                    ) : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
