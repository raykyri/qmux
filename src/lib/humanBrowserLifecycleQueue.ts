/**
 * Serializes ordinary browser updates across all overlay owners.
 * A rejection is deliberately swallowed only by the internal tail so one
 * failed WebKit operation cannot poison later updates. Cleanup bypasses this
 * queue and invalidates queued work with interrupt().
 */
export class HumanBrowserLifecycleQueue {
  private tail: Promise<void> = Promise.resolve();
  private epoch = 0;

  enqueue<T>(operation: () => Promise<T>, cancelled: () => T): Promise<T> {
    const epoch = this.epoch;
    const run = () => epoch === this.epoch ? operation() : cancelled();
    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Backend revisions cancel in-flight operations; this cancels queued work
   * and lets subsequent requests proceed without a stalled promise tail. */
  interrupt() {
    this.epoch += 1;
    this.tail = Promise.resolve();
  }
}

/** A failed retirement remains an obligation until acknowledged or superseded
 * by a reopen. Retries reuse the original backend revision. */
export class HumanBrowserRetirements {
  private pending = new Map<string, { timer: ReturnType<typeof setTimeout> | null }>();

  cancel(ownerId: string) {
    const entry = this.pending.get(ownerId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.pending.delete(ownerId);
  }

  retire(ownerId: string, operation: () => Promise<void>, retryMs = 1000): Promise<void> {
    this.cancel(ownerId);
    const entry = { timer: null as ReturnType<typeof setTimeout> | null };
    this.pending.set(ownerId, entry);
    const attempt = async () => {
      if (this.pending.get(ownerId) !== entry) return;
      try {
        await operation();
        if (this.pending.get(ownerId) === entry) this.pending.delete(ownerId);
      } catch (error) {
        if (this.pending.get(ownerId) === entry) {
          entry.timer = setTimeout(() => { void attempt().catch(() => undefined); }, retryMs);
        }
        throw error;
      }
    };
    return attempt();
  }
}

/** The external opener may deactivate qmux immediately. Await native cleanup
 * first, and never let an old completion restore or close a newer overlay. */
export async function openAfterBrowserHide(input: {
  hide: () => Promise<boolean>;
  isCurrent: () => boolean;
  open: () => Promise<void>;
  restore: () => void;
}) {
  try {
    if (!await input.hide() || !input.isCurrent()) return;
    await input.open();
  } catch (error) {
    if (input.isCurrent()) input.restore();
    throw error;
  }
}

export function isHumanBrowserLifecycleBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("lifecycle is busy");
}

/** Visible updates may briefly contend with creation from an older document. */
export async function retryHumanBrowserLifecycle<T>(
  operation: () => Promise<T>,
  attempts = 5,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isHumanBrowserLifecycleBusy(error) || attempt === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 16 * (attempt + 1));
      });
    }
  }
  throw lastError;
}
