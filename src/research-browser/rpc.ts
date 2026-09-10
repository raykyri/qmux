import type { BrowserCall, BrowserHandlers } from "./protocol";

export class BrowserRpcError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "BrowserRpcError";
  }
}

/** Requests are scoped to one document/channel. Never replay writes on reload. */
export function createBrowserRpc(
  port: MessagePort,
  onEvent: (name: string, value: unknown) => void,
) {
  let sequence = 0;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  port.onmessage = ({ data }) => {
    if (data?.type === "event" && typeof data.name === "string") {
      onEvent(data.name, data.value);
      return;
    }
    if (data?.type !== "result") return;
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    clearTimeout(request.timer);
    if (data.error)
      request.reject(
        new BrowserRpcError(
          data.error.code,
          data.error.message,
          data.error.details,
        ),
      );
    else request.resolve(data.value);
  };
  const call: BrowserCall = (method, ...args) =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(
          new BrowserRpcError("DISCONNECTED", "Research Browser disconnected"),
        );
        return;
      }
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new BrowserRpcError(
            "TIMEOUT",
            "Request timed out; a write may still have completed. Refresh before retrying.",
          ),
        );
      }, 60_000);
      pending.set(id, { resolve, reject, timer });
      try {
        port.postMessage({ type: "request", id, method, args });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  return {
    call,
    dispose() {
      closed = true;
      port.close();
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(
          new BrowserRpcError("DISCONNECTED", "Research Browser reloaded"),
        );
      }
      pending.clear();
    },
  };
}

export function serveBrowserRpc(
  port: MessagePort,
  handlers: () => BrowserHandlers,
) {
  let closed = false;
  port.onmessage = async ({ data }) => {
    if (data?.type !== "request" || !Number.isSafeInteger(data.id)) return;
    const reply = (result: object) => {
      if (!closed) port.postMessage({ type: "result", id: data.id, ...result });
    };
    const methods = handlers();
    if (
      typeof data.method !== "string" ||
      !Object.prototype.hasOwnProperty.call(methods, data.method) ||
      !Array.isArray(data.args)
    ) {
      reply({
        error: {
          code: "UNKNOWN_METHOD",
          message: "Unsupported SDK method or malformed arguments",
        },
      });
      return;
    }
    try {
      const method = methods[data.method as keyof BrowserHandlers] as (
        ...args: unknown[]
      ) => unknown;
      const value = await method(...data.args);
      reply({ value });
    } catch (error) {
      reply({
        error: {
          code: "REQUEST_FAILED",
          message:
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : JSON.stringify(error),
          details: error instanceof Error ? undefined : error,
        },
      });
    }
  };
  return () => {
    closed = true;
    port.close();
  };
}
