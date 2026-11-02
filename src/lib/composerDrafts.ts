/** A draft revision belongs to a composer, not to a mounted textarea. */
export interface ComposerDraftRevision {
  readonly text: string;
}

/** Reconcile only the submitted revision. An identical replacement is a new
 * draft; suffixes appended to the submitted text remain ready to send. */
export function remainingComposerDraft(
  current: ComposerDraftRevision,
  submitted: ComposerDraftRevision,
): string {
  if (current === submitted) return "";
  if (
    submitted.text &&
    current.text !== submitted.text &&
    current.text.startsWith(submitted.text)
  ) {
    return current.text.slice(submitted.text.length).trimStart();
  }
  return current.text;
}

interface ComposerState {
  draft: ComposerDraftRevision;
  busy: boolean;
}

/** App-owned synchronous drafts keep keystrokes out of App's render path, while
 * continuations and remounted composers share the latest revision and busy bit.
 * Persistence remains the caller's responsibility. */
export class ComposerDrafts {
  private entries = new Map<string, ComposerState>();
  private listeners = new Set<() => void>();
  private retainedKeys: ReadonlySet<string> | null = null;

  retain(keys: ReadonlySet<string>): void {
    this.retainedKeys = keys;
    for (const [key, state] of this.entries) {
      if (!keys.has(key) && !state.busy) this.entries.delete(key);
    }
  }

  read(key: string, initial = ""): ComposerState {
    let state = this.entries.get(key);
    if (!state) {
      state = { draft: { text: initial }, busy: false };
      this.entries.set(key, state);
    }
    return state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(key: string, state: ComposerState): void {
    this.entries.set(key, state);
    for (const listener of this.listeners) listener();
  }

  set(key: string, text: string, edited = false): void {
    const state = this.read(key);
    if (state.draft.text !== text || edited) {
      this.publish(key, { ...state, draft: { text } });
    }
  }

  begin(key: string): boolean {
    const state = this.read(key);
    if (state.busy) return false;
    this.publish(key, { ...state, busy: true });
    return true;
  }

  end(key: string): void {
    this.publish(key, { ...this.read(key), busy: false });
    if (this.retainedKeys && !this.retainedKeys.has(key)) this.entries.delete(key);
  }
}
