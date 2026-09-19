/** Row-based scroll anchor for the virtualized Home activity feed: the key of
 * the row under the top edge of the viewport and its pixel offset from that
 * edge. The feed's row heights are measured, not known, so a pixel scrollTop
 * saved before the feed unmounts restores against fresh estimates and lands on
 * a different item; the row key does not drift. */
export interface ActivityFeedScrollAnchor {
  key: string;
  offset: number;
}

export interface ActivityFeedState {
  scroll: ActivityFeedScrollAnchor | null;
}

const ACTIVITY_FEED_STATE_KEY = "qmux.research-activity.state.v1";
type FeedStorage = Pick<Storage, "getItem" | "setItem">;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readSnapshot(storage: Pick<Storage, "getItem"> | undefined) {
  try {
    return record(JSON.parse(storage?.getItem(ACTIVITY_FEED_STATE_KEY) ?? "null"));
  } catch {
    return {};
  }
}

export function readActivityFeedState(storage?: Pick<Storage, "getItem">): ActivityFeedState {
  try {
    const values = record(readSnapshot(storage ?? globalThis.sessionStorage).values);
    const anchor = record(values.activityScroll);
    return {
      scroll:
        typeof anchor.key === "string" &&
        anchor.key !== "" &&
        typeof anchor.offset === "number" &&
        Number.isFinite(anchor.offset)
          ? { key: anchor.key, offset: anchor.offset }
          : null,
    };
  } catch {
    return { scroll: null };
  }
}

export function saveActivityFeedState(state: ActivityFeedState, storage?: FeedStorage) {
  try {
    const target = storage ?? globalThis.sessionStorage;
    if (!target) return;
    const snapshot = readSnapshot(target);
    target.setItem(
      ACTIVITY_FEED_STATE_KEY,
      JSON.stringify({
        ...snapshot,
        values: {
          ...record(snapshot.values),
          activityScroll: state.scroll,
        },
      }),
    );
  } catch {
    // The App-owned ref still preserves the anchor across navigation when
    // WebKit denies storage or the session storage quota has been reached.
  }
}
