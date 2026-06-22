// Runs Whisper locally — in this Web Worker, off the UI thread — via
// transformers.js (ONNX Runtime on the WASM backend). This is what backs
// dictation: unlike the browser's Web Speech API, which streams audio to
// Google's servers, nothing transcribed here leaves the machine. The model is
// fetched once from the Hugging Face hub and cached in Tauri's app-cache
// directory afterwards, so later sessions load it from disk and work offline.
//
// Protocol (main thread ⇄ worker):
//   → { type: 'load' }                      ask it to (lazily) load the model
//   ← { type: 'progress', data }            load/init progress for the UI
//   ← { type: 'ready' }                     model is ready to transcribe
//   → { type: 'transcribe', jobId, audio }  16 kHz mono Float32 PCM window
//   ← { type: 'result', jobId, text }       transcript (text null if skipped)
//   ← { type: 'error', error }              model couldn't load (terminal)
//   ← { type: 'cache:request', ... }        ask main thread to read/write cache
//   → { type: 'cache:response', ... }       cache operation result

import { type AutomaticSpeechRecognitionPipeline, env, pipeline } from "@huggingface/transformers";

// Fetch the model and the onnxruntime-web runtime from the network (the Hugging
// Face hub and the ORT CDN) rather than vendoring them into the app. The Tauri
// CSP is widened just enough to permit those hosts (see tauri.conf.json).
env.allowRemoteModels = true;
env.allowLocalModels = false;
env.useBrowserCache = false;

// English Whisper. small.en for accuracy — noticeably better than base.en on
// real-world/noisy speech.
const MODEL = "Xenova/whisper-small.en";

type Pipe = AutomaticSpeechRecognitionPipeline;

function post(message: unknown) {
  (globalThis as unknown as { postMessage: (m: unknown) => void }).postMessage(message);
}

type NativeCacheHeader = { name: string; value: string };
type NativeCacheMetadata = { size: number; headers: NativeCacheHeader[] };
type CacheRpcMethod = "metadata" | "read" | "putStart" | "putChunk" | "putFinish" | "delete";
type CacheRpcResult = Record<string, unknown>;
type PendingCacheRequest = {
  resolve: (value: CacheRpcResult) => void;
  reject: (reason: Error) => void;
};

const IPC_CHUNK_BYTES = 1024 * 1024;
const BASE64_CHAR_CHUNK = 0x8000;

let nextCacheRequestId = 1;
const pendingCacheRequests = new Map<number, PendingCacheRequest>();

function cacheRpc<T = CacheRpcResult>(
  method: CacheRpcMethod,
  payload: CacheRpcResult = {},
): Promise<T> {
  const cacheRequestId = nextCacheRequestId++;
  return new Promise((resolve, reject) => {
    pendingCacheRequests.set(cacheRequestId, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    post({ type: "cache:request", cacheRequestId, method, ...payload });
  });
}

function handleCacheResponse(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const response = message as {
    type?: string;
    cacheRequestId?: number;
    ok?: boolean;
    error?: string;
  } & CacheRpcResult;
  if (response.type !== "cache:response" || typeof response.cacheRequestId !== "number") {
    return false;
  }
  const pending = pendingCacheRequests.get(response.cacheRequestId);
  if (!pending) return true;
  pendingCacheRequests.delete(response.cacheRequestId);
  if (response.ok) pending.resolve(response);
  else pending.reject(new Error(response.error ?? "dictation cache request failed"));
  return true;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += BASE64_CHAR_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHAR_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(raw: string): Uint8Array {
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function shouldValidateModelFile(request: string): boolean {
  return /\.(onnx|json)(\?|$)/.test(request);
}

function isNativeCacheMetadata(value: unknown): value is NativeCacheMetadata {
  const metadata = value as NativeCacheMetadata | null;
  return !!metadata && typeof metadata.size === "number" && Array.isArray(metadata.headers);
}

function headersFromMetadata(metadata: NativeCacheMetadata): Headers {
  const headers = new Headers();
  for (const header of metadata.headers) headers.append(header.name, header.value);
  headers.set("content-length", String(metadata.size));
  return headers;
}

async function readNativeCacheChunk(request: string, offset: number, length: number): Promise<Uint8Array> {
  const result = await cacheRpc<{ dataBase64?: unknown }>("read", { request, offset, length });
  if (typeof result.dataBase64 !== "string") {
    throw new Error("dictation cache returned an invalid chunk");
  }
  return base64ToBytes(result.dataBase64);
}

async function deleteNativeCacheEntry(request: string): Promise<boolean> {
  const result = await cacheRpc<{ deleted?: unknown }>("delete", { request });
  return result.deleted === true;
}

async function writeNativeCacheBytes(
  request: string,
  bytes: Uint8Array,
  progress: { loaded: number; total: number },
  progress_callback?: (data: { progress: number; loaded: number; total: number }) => void,
) {
  for (let offset = 0; offset < bytes.byteLength; offset += IPC_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + IPC_CHUNK_BYTES);
    await cacheRpc("putChunk", { request, dataBase64: bytesToBase64(chunk) });
    progress.loaded += chunk.byteLength;
    progress_callback?.({
      progress: progress.total > 0 ? (progress.loaded / progress.total) * 100 : 0,
      loaded: progress.loaded,
      total: progress.total,
    });
  }
}

async function writeNativeCacheResponse(
  request: string,
  response: Response,
  progress_callback?: (data: { progress: number; loaded: number; total: number }) => void,
) {
  const total = Number(response.headers.get("content-length")) || 0;
  const progress = { loaded: 0, total };
  const reader = response.body?.getReader();
  if (!reader) {
    await writeNativeCacheBytes(request, new Uint8Array(await response.arrayBuffer()), progress, progress_callback);
    return;
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) await writeNativeCacheBytes(request, value, progress, progress_callback);
    }
  } finally {
    reader.releaseLock();
  }
}

const nativeCache = {
  async match(request: string): Promise<Response | undefined> {
    const result = await cacheRpc<{ metadata?: unknown }>("metadata", { request });
    if (!isNativeCacheMetadata(result.metadata)) return undefined;

    const metadata = result.metadata;
    const headers = headersFromMetadata(metadata);
    if (shouldValidateModelFile(request)) {
      const head = await readNativeCacheChunk(request, 0, Math.min(64, metadata.size));
      if (isCorruptModelBytes(headers, head)) {
        await deleteNativeCacheEntry(request).catch(() => undefined);
        return undefined;
      }
    }

    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset >= metadata.size) {
          controller.close();
          return;
        }
        const bytes = await readNativeCacheChunk(
          request,
          offset,
          Math.min(IPC_CHUNK_BYTES, metadata.size - offset),
        );
        if (bytes.byteLength === 0) {
          controller.error(new Error("dictation cache ended before the stored size"));
          return;
        }
        offset += bytes.byteLength;
        controller.enqueue(bytes);
      },
    });
    return new Response(stream, { headers });
  },

  async put(
    request: string,
    response: Response,
    progress_callback?: (data: { progress: number; loaded: number; total: number }) => void,
  ): Promise<void> {
    const headers = Array.from(response.headers.entries()).map(([name, value]) => ({ name, value }));
    await cacheRpc("putStart", { request, headers });
    try {
      await writeNativeCacheResponse(request, response, progress_callback);
      await cacheRpc("putFinish", { request });
    } catch (err) {
      await deleteNativeCacheEntry(request).catch(() => undefined);
      throw err;
    }
  },

  async delete(request: string): Promise<boolean> {
    return deleteNativeCacheEntry(request);
  },
};

env.useCustomCache = true;
env.customCache = nativeCache;

let pipePromise: Promise<Pipe> | null = null;

// Prefer the GPU: on small.en, WebGPU with q4f16 weights (4-bit, fp16 compute;
// ~191 MB) runs many times faster than the WASM/CPU backend — fast enough for
// live dictation. Fall back to the WASM/CPU backend with q8 weights (~73 MB)
// where WebGPU is unavailable (the macOS WebView, GPU disabled), at several
// seconds per pass.
async function pickBackend(): Promise<{ device: "webgpu" | "wasm"; dtype: "q4f16" | "q8" }> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu && (await gpu.requestAdapter())) return { device: "webgpu", dtype: "q4f16" };
  } catch {
    /* no usable adapter — fall back to CPU */
  }
  return { device: "wasm", dtype: "q8" };
}

async function buildPipeline(): Promise<Pipe> {
  const progress_callback = (p: unknown) => post({ type: "progress", data: p });
  const { device, dtype } = await pickBackend();
  return pipeline("automatic-speech-recognition", MODEL, {
    device,
    dtype,
    // Cap graph optimization at 'basic'. Required on the q8/WASM path —
    // onnxruntime-web's extended optimizer otherwise crashes session creation
    // (TransposeDQWeightsForMatMulNBits looks for a block-quant scale the q8
    // merged decoder doesn't carry) — and harmless on WebGPU, where q4f16 still
    // runs fully GPU-accelerated under it.
    session_options: { graphOptimizationLevel: "basic" },
    progress_callback,
  }) as Promise<Pipe>;
}

// Read up to `n` leading bytes of a cached response without buffering the whole
// (possibly ~50 MB) body — enough to fingerprint what kind of file it is.
async function peek(resp: Response, n: number): Promise<Uint8Array> {
  const reader = resp.body?.getReader();
  if (!reader) return new Uint8Array(await resp.arrayBuffer()).subarray(0, n);
  const { value } = await reader.read();
  await reader.cancel();
  return (value ?? new Uint8Array()).subarray(0, n);
}

// True if a cached model file is one of the non-model payloads HF can serve in
// place of real weights: an HTML error page or a Git-LFS pointer. A real .onnx
// is large binary (its protobuf starts with 0x08); a real config is JSON.
function isCorruptModelBytes(headers: Headers, head: Uint8Array): boolean {
  if ((headers.get("content-type") ?? "").includes("text/html")) return true;
  const text = new TextDecoder().decode(head);
  if (text.startsWith("version https://git-lfs") || /^\s*<(!doctype|html)/i.test(text)) return true;
  if (/^\s*[\[{]/.test(text)) return false;
  return head.length < 16; // no real model file is this small
}

async function isCorruptModelFile(resp: Response): Promise<boolean> {
  const head = await peek(resp, 64);
  return isCorruptModelBytes(resp.headers, head);
}

// Older builds used the WebView's Cache Storage bucket ('transformers-cache').
// A bad entry from an earlier run — an HTML error page or an LFS pointer cached
// under a model URL — otherwise fails *every* load with ORT's "protobuf parsing
// failed" (INVALID_PROTOBUF) and never recovers: once a build fails,
// transformers memoizes the broken load in memory, so purging the cache
// mid-flight and retrying just replays the failure. Sweep that legacy cache
// before the first build. Best-effort — if it can't be inspected, just load.
async function evictCorruptModelFiles(): Promise<void> {
  const cs = (globalThis as unknown as { caches?: CacheStorage }).caches;
  if (!cs) return;
  try {
    for (const name of await cs.keys()) {
      if (!name.includes("transformers")) continue;
      const cache = await cs.open(name);
      for (const req of await cache.keys()) {
        if (!shouldValidateModelFile(req.url)) continue;
        const resp = await cache.match(req);
        if (resp && (await isCorruptModelFile(resp))) await cache.delete(req);
      }
    }
  } catch {
    /* best effort */
  }
}

function load(): Promise<Pipe> {
  if (pipePromise) return pipePromise;
  pipePromise = evictCorruptModelFiles().then(buildPipeline);
  // On a terminal failure forget the promise, so a later mic click retries from
  // scratch instead of replaying the cached rejection.
  pipePromise.catch(() => {
    pipePromise = null;
  });
  return pipePromise;
}

// One inference at a time. The main thread already waits for each result before
// sending the next window; this guards against any overlap regardless.
let busy = false;

async function handle(msg: { type: string; audio?: Float32Array; jobId?: number }) {
  if (msg.type === "load") {
    try {
      await load();
      post({ type: "ready" });
    } catch (err) {
      post({ type: "error", error: String(err) });
    }
    return;
  }
  if (msg.type === "transcribe") {
    if (busy || !msg.audio) {
      post({ type: "result", jobId: msg.jobId, text: null });
      return;
    }
    busy = true;
    try {
      const pipe = await load();
      const out = (await pipe(msg.audio)) as { text?: string } | { text?: string }[];
      const text = Array.isArray(out) ? out.map((o) => o.text ?? "").join(" ") : (out.text ?? "");
      post({ type: "result", jobId: msg.jobId, text });
    } catch {
      // A failed inference just drops this window — a load failure already
      // surfaced via the 'load' path, and transient errors shouldn't end the
      // session.
      post({ type: "result", jobId: msg.jobId, text: null });
    } finally {
      busy = false;
    }
  }
}

globalThis.addEventListener("message", (e) => {
  const message = (e as MessageEvent).data;
  if (handleCacheResponse(message)) return;
  void handle(message);
});
