// Helpers for the saved prompt library: placeholder discovery/fill (Smithers-style
// `{name}` slots read from the prompt text, never stored as separate metadata) and
// the window event that carries an "insert into composer" request from the pane
// header's library menu to the composer that owns the textarea and its caret.

// A placeholder is a brace-wrapped identifier: `{target}`, `{file_path}`, `{PR-number}`.
// Anything with spaces or other punctuation is treated as literal text, so JSON or
// code snippets inside a prompt don't sprout accidental inputs.
const PLACEHOLDER_PATTERN = /\{([A-Za-z_][A-Za-z0-9_-]*)\}/g;

/** Unique placeholder names in `content`, in first-appearance order. */
export function discoverPlaceholders(content: string): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(PLACEHOLDER_PATTERN)) {
    if (!names.includes(match[1])) {
      names.push(match[1]);
    }
  }
  return names;
}

/** Replaces each `{name}` with its value; blank values leave the slot as-is so the
 *  user can still fill it in the composer. */
export function fillPlaceholders(content: string, values: Record<string, string>): string {
  return content.replace(PLACEHOLDER_PATTERN, (token, name: string) => {
    const value = values[name]?.trim();
    return value ? value : token;
  });
}

const COMPOSER_INSERT_EVENT = "qmux:composer-insert";

interface ComposerInsertDetail {
  agentId: string;
  text: string;
}

/** Asks the composer bound to `agentId` to insert `text` at its caret and focus. */
export function requestComposerInsert(agentId: string, text: string) {
  window.dispatchEvent(
    new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, {
      detail: { agentId, text },
    }),
  );
}

/** Subscribes a composer to insert requests; returns the unsubscribe function. */
export function listenToComposerInsert(
  agentId: string,
  onInsert: (text: string) => void,
): () => void {
  const handler = (event: Event) => {
    const { detail } = event as CustomEvent<ComposerInsertDetail>;
    if (detail?.agentId === agentId && typeof detail.text === "string") {
      onInsert(detail.text);
    }
  };
  window.addEventListener(COMPOSER_INSERT_EVENT, handler);
  return () => window.removeEventListener(COMPOSER_INSERT_EVENT, handler);
}
