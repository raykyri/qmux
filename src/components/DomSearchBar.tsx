import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { IS_MAC, isEditableTarget, isTerminalTarget } from "../lib/appHelpers";
import {
  applySearchHighlights,
  clearSearchHighlights,
  collectSearchRanges,
  nearestSearchRangeIndex,
  scrollSearchRangeIntoView,
} from "../lib/transcriptSearch";
import PaneSearchBar from "./PaneSearchBar";

interface DomSearchBarProps {
  active: boolean;
  placeholder: string;
  rootRef: RefObject<HTMLElement | null>;
  viewportRef?: RefObject<HTMLElement | null>;
  hotkeyScopeRef?: RefObject<HTMLElement | null>;
  resetKey?: unknown;
}

// Shared Cmd-F search for React-rendered panes. The host supplies the rendered
// text root and its scroll viewport; this component owns the find UI, DOM Range
// collection, highlighting, navigation, and content-change rescans.
export default function DomSearchBar({
  active,
  placeholder,
  rootRef,
  viewportRef = rootRef,
  hotkeyScopeRef = rootRef,
  resetKey,
}: DomSearchBarProps) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [results, setResults] = useState({ index: -1, count: 0 });
  const [debouncedTerm, setDebouncedTerm] = useState("");
  const rangesRef = useRef<Range[]>([]);
  const ownerRef = useRef<object>({});
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debouncedTermRef = useRef(debouncedTerm);
  const suppressScrollRef = useRef(false);
  const contentRescanTimerRef = useRef<number | null>(null);
  const rescanRef = useRef((_contentDriven: boolean) => {});
  debouncedTermRef.current = debouncedTerm;

  const close = () => {
    inputRef.current?.blur();
    setOpen(false);
  };

  // Blur while the input is still attached if its host pane unmounts. WebKit
  // does not reliably dispatch focusout after removing a focused subtree.
  useLayoutEffect(() => {
    return () => {
      const input = inputRef.current;
      if (input && document.activeElement === input) {
        input.blur();
      }
    };
  }, []);

  // Cmd-F (macOS) / Ctrl-F opens the active rendered pane's find bar. A native
  // terminal keeps ownership while focused, and editables outside this pane
  // keep the chord for their own surface.
  useEffect(() => {
    if (!active) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const findCombo = IS_MAC
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (
        event.defaultPrevented ||
        !findCombo ||
        event.altKey ||
        (event.key !== "f" && event.key !== "F")
      ) {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (isTerminalTarget(target)) {
          return;
        }
        if (!hotkeyScopeRef.current?.contains(target) && isEditableTarget(target)) {
          return;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
      // Select even when the bar is already open, matching native terminal find.
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active, hotkeyScopeRef]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  // A new document/transcript should not inherit an open find bar from the
  // previous one. Preserve the term and options so reopening can repeat it.
  useEffect(() => {
    inputRef.current?.blur();
    setOpen(false);
  }, [resetKey]);

  useEffect(() => {
    if (term === "") {
      setDebouncedTerm("");
      return;
    }
    const handle = window.setTimeout(() => setDebouncedTerm(term), 120);
    return () => window.clearTimeout(handle);
  }, [term]);

  rescanRef.current = (contentDriven: boolean) => {
    const root = rootRef.current;
    const viewport = viewportRef.current;
    if (!root || !viewport) {
      return;
    }
    const ranges =
      debouncedTerm === ""
        ? []
        : collectSearchRanges(root, debouncedTerm, {
            caseSensitive,
            regex: useRegex,
          });
    rangesRef.current = ranges;
    suppressScrollRef.current = contentDriven;
    setResults({ index: nearestSearchRangeIndex(viewport, ranges), count: ranges.length });
  };

  // Term and option changes are user-driven, so update immediately after the
  // input debounce and allow the nearest result to scroll into view.
  useEffect(() => {
    if (open) {
      rescanRef.current(false);
    }
  }, [open, debouncedTerm, caseSensitive, useRegex]);

  // Rendered markdown can change without a React prop the search controller
  // knows about (streaming text, diagrams, expanded details). Observe the DOM
  // and coalesce those rescans without moving the reader's viewport.
  useEffect(() => {
    if (!open) {
      return;
    }
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const scheduleRescan = () => {
      if (debouncedTermRef.current === "" || contentRescanTimerRef.current !== null) {
        return;
      }
      contentRescanTimerRef.current = window.setTimeout(() => {
        contentRescanTimerRef.current = null;
        rescanRef.current(true);
      }, 250);
    };
    const observer = new MutationObserver(scheduleRescan);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    root.addEventListener("toggle", scheduleRescan, true);
    return () => {
      observer.disconnect();
      root.removeEventListener("toggle", scheduleRescan, true);
    };
  }, [open, rootRef]);

  useEffect(() => {
    if (open) {
      return;
    }
    if (contentRescanTimerRef.current !== null) {
      window.clearTimeout(contentRescanTimerRef.current);
      contentRescanTimerRef.current = null;
    }
  }, [open]);
  useEffect(
    () => () => {
      if (contentRescanTimerRef.current !== null) {
        window.clearTimeout(contentRescanTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const owner = ownerRef.current;
    if (!open || !active) {
      clearSearchHighlights(owner);
      return;
    }
    const ranges = rangesRef.current;
    applySearchHighlights(owner, ranges, results.index);
    const suppressScroll = suppressScrollRef.current;
    suppressScrollRef.current = false;
    const range = ranges[results.index];
    const viewport = viewportRef.current;
    if (range && viewport && !suppressScroll) {
      scrollSearchRangeIntoView(viewport, range);
    }
    return () => clearSearchHighlights(owner);
  }, [active, open, results, viewportRef]);

  const step = (delta: 1 | -1) => {
    suppressScrollRef.current = false;
    setResults((current) =>
      current.count === 0
        ? current
        : { ...current, index: (current.index + delta + current.count) % current.count },
    );
  };

  return open ? (
    <PaneSearchBar
      inputRef={inputRef}
      placeholder={placeholder}
      term={term}
      onTermChange={setTerm}
      matchIndex={results.index}
      matchCount={results.count}
      caseSensitive={caseSensitive}
      onCaseSensitiveChange={setCaseSensitive}
      useRegex={useRegex}
      onUseRegexChange={setUseRegex}
      onFindNext={() => step(1)}
      onFindPrevious={() => step(-1)}
      onClose={close}
    />
  ) : null;
}
