import { useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

// The find bar shared by the native terminal search action and the transcript
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
  showOptions = true,
  onFindNext,
  onFindPrevious,
  onClose,
  onFocusLeave,
}: {
  inputRef?: RefObject<HTMLInputElement | null>;
  placeholder: string;
  term: string;
  onTermChange: (term: string) => void;
  // Zero-based index of the active match, -1 when none is selected.
  matchIndex: number;
  matchCount: number | null;
  caseSensitive: boolean;
  onCaseSensitiveChange: (value: boolean) => void;
  useRegex: boolean;
  onUseRegexChange: (value: boolean) => void;
  showOptions?: boolean;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onClose: () => void;
  onFocusLeave?: () => void;
}) {
  const matchLabel =
    term === "" || matchCount === null
      ? ""
      : matchCount === 0
        ? "No results"
        : `${matchIndex + 1}/${matchCount}`;
  const hasMatches = matchCount === null ? term.length > 0 : matchCount > 0;

  // WebKit does not focus <button> elements on mousedown, so pressing one of
  // the bar's own buttons blurs the input with relatedTarget: null — the same
  // shape as focus genuinely leaving the bar. Reporting onFocusLeave right
  // then can unmount the bar before the button's click ever dispatches. Track
  // pointer presses that start inside the bar and hold the leave callback
  // until the click has run.
  const pointerDownInsideRef = useRef(false);

  const handlePointerDownCapture = () => {
    pointerDownInsideRef.current = true;
    const clear = () => {
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("pointercancel", clear);
      // Let the click that follows this pointerup dispatch first.
      setTimeout(() => {
        pointerDownInsideRef.current = false;
      }, 0);
    };
    window.addEventListener("pointerup", clear);
    window.addEventListener("pointercancel", clear);
  };

  // Keep the bar holding a live focus target after one of its buttons runs;
  // without this the click leaves focus on <body>, and the next keystroke
  // would fall through to whatever owns the keyboard instead of the search.
  const refocusInput = () => {
    inputRef?.current?.focus();
  };

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
    <div
      className="pane-search"
      role="search"
      onPointerDownCapture={handlePointerDownCapture}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
          return;
        }
        if (pointerDownInsideRef.current) {
          return;
        }
        onFocusLeave?.();
      }}
    >
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
      {showOptions ? <div className="pane-search-toggles">
        <button
          type="button"
          className={`pane-search-toggle ${caseSensitive ? "is-active" : ""}`}
          title="Match case"
          aria-pressed={caseSensitive}
          onClick={() => {
            onCaseSensitiveChange(!caseSensitive);
            refocusInput();
          }}
        >
          Aa
        </button>
        <button
          type="button"
          className={`pane-search-toggle ${useRegex ? "is-active" : ""}`}
          title="Use regular expression"
          aria-pressed={useRegex}
          onClick={() => {
            onUseRegexChange(!useRegex);
            refocusInput();
          }}
        >
          .*
        </button>
      </div> : null}
      <div className="pane-search-nav">
        <button
          type="button"
          className="pane-search-button"
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
          disabled={!hasMatches}
          onClick={() => {
            onFindPrevious();
            refocusInput();
          }}
        >
          ↑
        </button>
        <button
          type="button"
          className="pane-search-button"
          title="Next match (Enter)"
          aria-label="Next match"
          disabled={!hasMatches}
          onClick={() => {
            onFindNext();
            refocusInput();
          }}
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
