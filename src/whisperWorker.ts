// Runs Whisper locally — in this Web Worker, off the UI thread — via
// transformers.js (ONNX Runtime on the WASM backend). This is what backs
// dictation: unlike the browser's Web Speech API, which streams audio to
// Google's servers, nothing transcribed here leaves the machine. The model is
// fetched once from the Hugging Face hub and the WebView caches it (Cache
// Storage) afterwards, so later sessions load it from disk and work offline.
//
// Protocol (main thread ⇄ worker):
//   → { type: 'load' }                      ask it to (lazily) load the model
//   ← { type: 'progress', data }            download/init progress for the UI
//   ← { type: 'ready' }                     model is ready to transcribe
//   → { type: 'transcribe', jobId, audio }  16 kHz mono Float32 PCM window
//   ← { type: 'result', jobId, text }       transcript (text null if skipped)
//   ← { type: 'error', error }              model couldn't load (terminal)

import { type AutomaticSpeechRecognitionPipeline, env, pipeline } from "@huggingface/transformers";

// Fetch the model and the onnxruntime-web runtime from the network (the Hugging
// Face hub and the ORT CDN) rather than vendoring them into the app. The Tauri
// CSP is widened just enough to permit those hosts (see tauri.conf.json). The
// WebView caches both after the first load, so dictation then works offline.
env.allowRemoteModels = true;
env.allowLocalModels = false;

// English Whisper. small.en for accuracy — noticeably better than base.en on
// real-world/noisy speech.
const MODEL = "Xenova/whisper-small.en";

type Pipe = AutomaticSpeechRecognitionPipeline;

function post(message: unknown) {
  (globalThis as unknown as { postMessage: (m: unknown) => void }).postMessage(message);
}

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
async function isCorruptModelFile(resp: Response): Promise<boolean> {
  if ((resp.headers.get("content-type") ?? "").includes("text/html")) return true;
  const head = await peek(resp, 64);
  if (head.length < 16) return true; // no real model file is this small
  const text = new TextDecoder().decode(head);
  return text.startsWith("version https://git-lfs") || /^\s*<(!doctype|html)/i.test(text);
}

// transformers.js caches every downloaded model file in a Cache Storage bucket
// ('transformers-cache'). A bad entry from an earlier run — an HTML error page
// or an LFS pointer cached under a model URL — otherwise fails *every* load with
// ORT's "protobuf parsing failed" (INVALID_PROTOBUF) and never recovers: once a
// build fails, transformers memoizes the broken load in memory, so purging the
// cache mid-flight and retrying just replays the failure. So sweep the cache
// *before* the first build and drop any corrupt entry; the build then re-fetches
// a clean copy. Best-effort — if the cache can't be inspected, just try to load.
async function evictCorruptModelFiles(): Promise<void> {
  const cs = (globalThis as unknown as { caches?: CacheStorage }).caches;
  if (!cs) return;
  try {
    for (const name of await cs.keys()) {
      if (!name.includes("transformers")) continue;
      const cache = await cs.open(name);
      for (const req of await cache.keys()) {
        if (!/\.(onnx|json)(\?|$)/.test(req.url)) continue;
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

globalThis.addEventListener("message", (e) => handle((e as MessageEvent).data));
