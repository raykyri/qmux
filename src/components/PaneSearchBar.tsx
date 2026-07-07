import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

// The find bar shared by the terminal (xterm SearchAddon) and the transcript
// (DOM-range search). Owns only presentation and the Enter/Shift+Enter/Escape
// keys; the match engine, open/close state, and focus management stay with the
// host pane.
export default function PaneSearchBar({
  inputRef,
  placeholder,
  term,
  onTermChange,
  matchIndex,
  matchCount,
  caseSensitive,
  onCaseSensitiveChange,
  useRegex,
  onUseRegexChange,
  onFindNext,
  onFindPrevious,
  onClose,
}: {
  inputRef?: RefObject<HTMLInputElement | null>;
  placeholder: string;
  term: string;
  onTermChange: (term: string) => void;
  // Zero-based index of the active match, -1 when none is selected.
  matchIndex: number;
  matchCount: number;
  caseSensitive: boolean;
  onCaseSensitiveChange: (value: boolean) => void;
  useRegex: boolean;
  onUseRegexChange: (value: boolean) => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onClose: () => void;
}) {
  const matchLabel =
    term === "" ? "" : matchCount === 0 ? "No results" : `${matchIndex + 1}/${matchCount}`;
  const hasMatches = matchCount > 0;

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        onFindPrevious();
      } else {
        onFindNext();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="pane-search" role="search">
      <input
        ref={inputRef}
        type="text"
        className="pane-search-input"
        value={term}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        aria-label={placeholder}
        onChange={(event) => onTermChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      <span className="pane-search-count">{matchLabel}</span>
      <div className="pane-search-toggles">
        <button
          type="button"
          className={`pane-search-toggle ${caseSensitive ? "is-active" : ""}`}
          title="Match case"
          aria-pressed={caseSensitive}
          onClick={() => onCaseSensitiveChange(!caseSensitive)}
        >
          Aa
        </button>
        <button
          type="button"
          className={`pane-search-toggle ${useRegex ? "is-active" : ""}`}
          title="Use regular expression"
          aria-pressed={useRegex}
          onClick={() => onUseRegexChange(!useRegex)}
        >
          .*
        </button>
      </div>
      <div className="pane-search-nav">
        <button
          type="button"
          className="pane-search-button"
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
          disabled={!hasMatches}
          onClick={onFindPrevious}
        >
          ↑
        </button>
        <button
          type="button"
          className="pane-search-button"
          title="Next match (Enter)"
          aria-label="Next match"
          disabled={!hasMatches}
          onClick={onFindNext}
        >
          ↓
        </button>
        <button
          type="button"
          className="pane-search-button"
          title="Close (Esc)"
          aria-label="Close search"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
