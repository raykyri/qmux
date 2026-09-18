// Helpers for the saved prompt library: placeholder discovery/fill (Smithers-style
// `{name}` slots read from the prompt text, never stored as separate metadata) and
// the window event that carries an "insert into composer" request from the pane
// header's library menu to the composer that owns the textarea and its caret.

import { COMPOSER_SLASH_COMMANDS } from "./composerSlashCommands";
import type { SavedPrompt } from "../types";

export const MAX_PROMPT_NAME_CHARS = 120;

export function slugifyPromptNameInput(value: string): string {
  return Array.from(
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+/g, "-"),
  )
    .slice(0, MAX_PROMPT_NAME_CHARS)
    .join("");
}

export function slugifyPromptName(value: string): string {
  return slugifyPromptNameInput(value).replace(/-+$/, "");
}

export function promptNameError(
  name: string,
  prompts: readonly SavedPrompt[],
  original?: Pick<SavedPrompt, "name" | "scope"> | null,
): string | null {
  const slug = slugifyPromptName(name);
  if (!slug) {
    return "Enter a prompt name";
  }
  if (COMPOSER_SLASH_COMMANDS.some((command) => command.name === slug)) {
    return `/${slug} is reserved by qMux`;
  }
  if (
    prompts.some(
      (prompt) =>
        prompt.name.toLowerCase() === slug &&
        !(original && prompt.name === original.name && prompt.scope === original.scope),
    )
  ) {
    return `/${slug} is already used by another prompt`;
  }
  return null;
}

export function matchingSavedPromptSlashCommands(
  value: string,
  prompts: readonly SavedPrompt[],
): SavedPrompt[] {
  if (!/^\/[^\s]*$/.test(value)) {
    return [];
  }
  const query = value.slice(1);
  const reserved = new Set<string>(COMPOSER_SLASH_COMMANDS.map((command) => command.name));
  const counts = new Map<string, number>();
  for (const prompt of prompts) {
    const name = prompt.name.toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return prompts
    .filter((prompt) => {
      const name = prompt.name.toLowerCase();
      return !reserved.has(name) && counts.get(name) === 1 && name.startsWith(query);
    })
    .sort((a, b) => {
      const aExact = a.name.toLowerCase() === query;
      const bExact = b.name.toLowerCase() === query;
      return Number(bExact) - Number(aExact) || a.name.localeCompare(b.name);
    });
}

export function savedPromptForExactSlashCommand(
  value: string,
  prompts: readonly SavedPrompt[],
): SavedPrompt | null {
  if (!/^\/[^\s]+$/.test(value)) {
    return null;
  }
  const matches = matchingSavedPromptSlashCommands(value, prompts);
  return matches.find((prompt) => `/${prompt.name}` === value) ?? null;
}

export function completeSavedPromptSlashCommand(value: string, prompt: SavedPrompt): string {
  const token = `/${prompt.name}`;
  return value === token ? prompt.content : token;
}

export function shouldExpandExactSavedPromptOnKey(key: string, slashMenuOpen: boolean): boolean {
  return key === " " || (key === "Enter" && !slashMenuOpen);
}

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
    // A placeholder name like `constructor`, `toString`, or `__proto__` would
    // otherwise read an inherited Object.prototype member; `.trim()` on that
    // non-string throws and blocks insertion. Only own string values count.
    const value =
      Object.prototype.hasOwnProperty.call(values, name) && typeof values[name] === "string"
        ? values[name].trim()
        : "";
    return value ? value : token;
  });
}

const COMPOSER_INSERT_EVENT = "qmux:composer-insert";
const SAVE_DRAFT_AS_PROMPT_EVENT = "qmux:save-draft-as-prompt";
const PROMPT_LIBRARY_CHANGED_EVENT = "qmux:prompt-library-changed";

export function notifyPromptLibraryChanged() {
  window.dispatchEvent(new Event(PROMPT_LIBRARY_CHANGED_EVENT));
}

export function listenToPromptLibraryChanged(onChange: () => void): () => void {
  window.addEventListener(PROMPT_LIBRARY_CHANGED_EVENT, onChange);
  return () => window.removeEventListener(PROMPT_LIBRARY_CHANGED_EVENT, onChange);
}

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

interface SaveDraftAsPromptDetail {
  agentId: string;
  text: string;
  lockToGlobal: boolean;
}

/** Opens the prompt-library editor for `agentId`, prefilled with reusable text. */
export function requestSaveDraftAsPrompt(
  agentId: string,
  text: string,
  { lockToGlobal = true }: { lockToGlobal?: boolean } = {},
) {
  window.dispatchEvent(
    new CustomEvent<SaveDraftAsPromptDetail>(SAVE_DRAFT_AS_PROMPT_EVENT, {
      detail: { agentId, text, lockToGlobal },
    }),
  );
}

/** Subscribes one pane's prompt library to prefilled save requests for its agent. */
export function listenToSaveDraftAsPrompt(
  agentId: string,
  onSaveDraft: (text: string, lockToGlobal: boolean) => void,
): () => void {
  const handler = (event: Event) => {
    const { detail } = event as CustomEvent<SaveDraftAsPromptDetail>;
    if (detail?.agentId === agentId && typeof detail.text === "string") {
      onSaveDraft(detail.text, detail.lockToGlobal !== false);
    }
  };
  window.addEventListener(SAVE_DRAFT_AS_PROMPT_EVENT, handler);
  return () => window.removeEventListener(SAVE_DRAFT_AS_PROMPT_EVENT, handler);
}
