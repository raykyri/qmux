import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { classNames } from "./classNames";

/*
 * A row matches when every search word appears in its label, hint, search text,
 * or section or group name. Matching ignores case: "terminal font" finds the
 * Font row in the Terminal section.
 */
const SettingsQueryContext = createContext<readonly string[]>([]);
const SettingsScopeContext = createContext("");

export function settingsQueryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function SettingsSearchProvider({
  query,
  children,
}: {
  query: string;
  children: ReactNode;
}) {
  const tokens = useMemo(() => settingsQueryTokens(query), [query]);
  return <SettingsQueryContext.Provider value={tokens}>{children}</SettingsQueryContext.Provider>;
}

/** Includes section or group names in each row’s search text. */
export function SettingsScope({ text, children }: { text: string; children: ReactNode }) {
  const parent = useContext(SettingsScopeContext);
  return (
    <SettingsScopeContext.Provider value={`${parent} ${text}`}>
      {children}
    </SettingsScopeContext.Provider>
  );
}

function useSettingsMatch(text: string): boolean {
  const tokens = useContext(SettingsQueryContext);
  const scope = useContext(SettingsScopeContext);
  if (tokens.length === 0) {
    return true;
  }
  const haystack = `${scope} ${text}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function highlightMatches(text: string, tokens: readonly string[]): ReactNode {
  if (tokens.length === 0) {
    return text;
  }
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const token of tokens) {
    for (let index = lower.indexOf(token); index >= 0; index = lower.indexOf(token, index + 1)) {
      marked.fill(true, index, index + token.length);
    }
  }
  const parts: ReactNode[] = [];
  let start = 0;
  for (let index = 1; index <= text.length; index += 1) {
    if (index === text.length || marked[index] !== marked[start]) {
      const slice = text.slice(start, index);
      parts.push(
        marked[start] ? (
          <mark key={start} className="settings-match">
            {slice}
          </mark>
        ) : (
          slice
        ),
      );
      start = index;
    }
  }
  return parts;
}

export interface SettingsGroupProps {
  /** Group heading. Also scopes search: "cursor" matches every row in Cursor. */
  title?: string;
  /** Omits the container styling for lists with their own container. */
  bare?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Groups settings under a heading. CSS hides groups with no search results.
 */
export function SettingsGroup({ title, bare = false, className, children }: SettingsGroupProps) {
  return (
    <SettingsScope text={title ?? ""}>
      <section className={classNames("settings-group-block", className)} aria-label={title}>
        {title ? <h3 className="settings-group-title">{title}</h3> : null}
        <div className={classNames("settings-group", bare && "is-bare")}>{children}</div>
      </section>
    </SettingsScope>
  );
}

export interface SettingsRowProps {
  /** Plain-text label; also the primary search text. */
  label: string;
  /** Control ID for the label. Omit if the control has its own label. */
  labelFor?: string;
  labelId?: string;
  hint?: ReactNode;
  hintId?: string;
  /** Extra words to match: synonyms, or the hint's text when the hint isn't a string. */
  searchText?: string;
  /** Inline status shown after the label, e.g. a permission state. */
  status?: ReactNode;
  /** Indents options controlled by the preset above. */
  indent?: boolean;
  /** Places the control below the label at full width. */
  stacked?: boolean;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * A setting with its label and hint on the left and control on the right
 * (or below when stacked).
 */
export function SettingsRow({
  label,
  labelFor,
  labelId,
  hint,
  hintId,
  searchText,
  status,
  indent = false,
  stacked = false,
  disabled = false,
  className,
  children,
}: SettingsRowProps) {
  const tokens = useContext(SettingsQueryContext);
  const matches = useSettingsMatch(
    [label, typeof hint === "string" ? hint : "", searchText ?? ""].join(" "),
  );
  if (!matches) {
    return null;
  }
  const labelContent = highlightMatches(label, tokens);
  return (
    <div
      className={classNames(
        "settings-row",
        indent && "is-indented",
        stacked && "is-stacked",
        disabled && "is-disabled",
        className,
      )}
    >
      <div className="settings-row-text">
        <div className="settings-row-heading">
          {labelFor ? (
            <label className="settings-row-label" htmlFor={labelFor} id={labelId}>
              {labelContent}
            </label>
          ) : (
            <span className="settings-row-label" id={labelId}>
              {labelContent}
            </span>
          )}
          {status}
        </div>
        {hint ? (
          <div className="settings-row-hint" id={hintId}>
            {hint}
          </div>
        ) : null}
      </div>
      {children ? <div className="settings-row-control">{children}</div> : null}
    </div>
  );
}

/** Wraps custom settings content (lists, previews) so search can include or hide it. */
export function SettingsSearchable({
  searchText,
  className,
  children,
}: {
  searchText: string;
  className?: string;
  children: ReactNode;
}) {
  if (!useSettingsMatch(searchText)) {
    return null;
  }
  return <div className={classNames("settings-searchable", className)}>{children}</div>;
}

/**
 * Emphasizes a command, path, or config key within a settings hint.
 */
export function SettingsLiteral({ children }: { children: ReactNode }) {
  return <span className="settings-literal">{children}</span>;
}

export type SettingsStatusTone = "ok" | "warning" | "attention" | "neutral";

export function SettingsStatus({
  tone,
  children,
}: {
  tone: SettingsStatusTone;
  children: ReactNode;
}) {
  return (
    <span className={`settings-status is-${tone}`}>
      <span className="settings-status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}
