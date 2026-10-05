export interface RemotePreviewTarget {
  paneId: string;
  transcript: string;
  path: string;
  fragment: string;
}
export interface RemotePreviewStatus {
  bytes: number;
  total: number | null;
  error: string | null;
  cachedAvailable: boolean;
  fetchedAt: number | null;
  url: string | null;
}
export interface RemotePreviewState extends RemotePreviewStatus {
  target: RemotePreviewTarget;
  cachedOnly: boolean;
}
export interface RemotePreviewApi {
  start: (target: RemotePreviewTarget, cachedOnly: boolean) => Promise<string>;
  status: (id: string) => Promise<RemotePreviewStatus>;
  close: (id: string) => Promise<void>;
}
interface Pending {
  state: RemotePreviewState;
  id?: string;
  timer?: ReturnType<typeof setTimeout>;
}
/** Request ownership is independent of React renders: obsolete responses cannot
 * publish a URL, and even a late start response has its backend handle released. */
export class RemotePreviewRequests {
  private pending = new Map<string, Pending>();
  constructor(
    private api: RemotePreviewApi,
    private changed: (states: Record<string, RemotePreviewState>) => void,
  ) {}
  private publish() {
    this.changed(Object.fromEntries([...this.pending].map(([owner, request]) => [owner, request.state])));
  }
  private release(id: string) {
    void this.api.close(id).catch(() => undefined);
  }
  open(target: RemotePreviewTarget, cachedOnly = false) {
    const old = this.pending.get(target.paneId);
    if (old?.timer) clearTimeout(old.timer);
    const request: Pending = {
      state: {
        target, cachedOnly, bytes: 0, total: null, error: null,
        cachedAvailable: false, fetchedAt: null, url: null,
      },
    };
    this.pending.set(target.paneId, request);
    this.publish();
    const current = () => this.pending.get(target.paneId) === request;
    const poll = async () => {
      try {
        const status = await this.api.status(request.id!);
        if (!current()) return;
        request.state = { ...request.state, ...status };
        this.publish();
        if (!status.url && !status.error) request.timer = setTimeout(() => void poll(), 250);
      } catch (error) {
        if (!current()) return;
        request.state = { ...request.state, error: String(error) };
        this.publish();
      }
    };
    void this.api.start(target, cachedOnly).then((id) => {
      // The new request now pins any cached predecessor; release the old view.
      if (old?.id) this.release(old.id);
      if (!current()) {
        this.release(id);
        return;
      }
      request.id = id;
      void poll();
    }, (error) => {
      if (old?.id) this.release(old.id);
      if (!current()) return;
      request.state = { ...request.state, error: String(error) };
      this.publish();
    });
  }
  close(owner: string) {
    const request = this.pending.get(owner);
    if (!request) return;
    this.pending.delete(owner);
    if (request.timer) clearTimeout(request.timer);
    if (request.id) this.release(request.id);
    this.publish();
  }
  dispose() {
    for (const owner of [...this.pending.keys()]) this.close(owner);
  }
}
