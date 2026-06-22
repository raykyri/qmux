// Live voice dictation for the composers, backed by Whisper running locally in a
// Web Worker (see whisperWorker.ts) rather than the browser's Web Speech API.
// The Web Speech API routes audio to Google's servers; this path needs no cloud
// service and works offline once the model is cached.
//
// How "live" is achieved without a streaming model: we capture mic audio as
// 16 kHz mono PCM, and a few times a second re-transcribe the current phrase's
// growing audio window, overwriting the text we last wrote into the textarea in
// place — so words appear and firm up as you speak. A short pause (or a hard
// length cap) finalizes the phrase: the text becomes permanent and the audio
// buffer is freed so the next phrase starts clean.
//
// This is a port of the Thread Builder (~/Code/tb) dictation hook, with its
// Lexical-editor integration replaced by a plain controlled <textarea> target:
// the in-place phrase overwrite is done by splicing the textarea's value string
// and restoring the caret, instead of mutating a Lexical selection.

import { useEffect, useRef, useState } from "react";
import { setDictationDownload } from "./dictationStatus";
import {
  dictationCacheDelete,
  dictationCacheMetadata,
  dictationCachePutChunk,
  dictationCachePutFinish,
  dictationCachePutStart,
  dictationCacheRead,
  type DictationCacheHeader,
} from "./lib/api";

// A human-readable tooltip for the failure reasons we surface on the mic.
export function dictationErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
      return "Dictation needs microphone access — allow it and try again";
    case "audio-capture":
      return "No microphone was found for dictation";
    case "model":
      return "Couldn't load the dictation model — check your connection and try again";
    default:
      return "Dictation stopped — click to try again";
  }
}

// The composer surface dictation writes into. Implemented over a controlled
// textarea: getText/getCaret read the live element, setText replaces the value
// (via React state) and repositions the caret.
export interface DictationTarget {
  // Current textarea contents.
  getText: () => string;
  // Caret offset (selectionStart) where a fresh phrase should anchor.
  getCaret: () => number;
  // Replace the whole text and place the caret at `caret`.
  setText: (text: string, caret: number) => void;
  // Pull focus back to the textarea (used when the mic is clicked).
  focus: () => void;
}

export interface Dictation {
  // Whether this environment can run local dictation at all (mic + workers + audio).
  supported: boolean;
  // Currently capturing — drives the mic's active/recording styling.
  listening: boolean;
  // The model is loading/initializing (first use, before any audio is
  // transcribed). `progress` is a coarse 0–100 for the current file, or null.
  loading: boolean;
  progress: number | null;
  // Set to an error code when dictation gave up (denied mic, no model, …); null
  // while fine. Drives the mic's tooltip. Cleared on the next start.
  error: string | null;
  // Start if idle, stop if listening.
  toggle: () => void;
  // Stop capturing (no-op if already idle). Called when the composer submits.
  stop: () => void;
}

const TARGET_RATE = 16000; // Whisper's expected sample rate.
const TICK_MS = 400; // How often we re-transcribe the growing window.
const SILENCE_COMMIT_MS = 900; // A pause this long finalizes the current phrase.
const MAX_WINDOW_S = 24; // Hard cap so one long breath can't grow the buffer forever.
const VOICE_RMS = 0.008; // Crude voice-activity gate: below this a frame is "silence".
// Once a phrase has run this long without finalizing, segment it at a shorter
// inter-clause gap (below) instead of holding out for a full SILENCE_COMMIT_MS
// pause. This bounds the live re-transcription window: left unbounded, a phrase
// spoken without a clear ~900ms pause grows toward the 24s cap, and since every
// pass re-transcribes the whole window, on the CPU/WASM backend each pass gets
// slower and falls seconds behind (dictation appears to stop around 15-20 words)
// while a degraded long-window result overwrites the text already shown in place
// (the phrase clears). People pause between clauses, so a shorter gap finalizes a
// long phrase at a natural boundary, freezing it before the window grows unwieldy.
const LONG_PHRASE_S = 5; // A phrase longer than this finalizes at the shorter gap.
const LONG_PHRASE_COMMIT_MS = 500; // Inter-clause gap that finalizes a long phrase.

type AudioCtxCtor = typeof AudioContext;

function getAudioCtor(): AudioCtxCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioCtxCtor; webkitAudioContext?: AudioCtxCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

// Linear-resample a mono buffer to 16 kHz (used only when the AudioContext won't
// honor a 16 kHz rate and hands us, say, 48 kHz frames).
function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_RATE) return input;
  const ratio = TARGET_RATE / inputRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i / ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = idx - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

type WorkerMessage = {
  type: string;
  text?: string | null;
  error?: string;
  jobId?: number;
  data?: { status?: string; file?: string; loaded?: number; total?: number };
};

type DictationCacheMethod =
  | "metadata"
  | "read"
  | "putStart"
  | "putChunk"
  | "putFinish"
  | "delete";

type DictationCacheRequest = {
  type: "cache:request";
  cacheRequestId: number;
  method: DictationCacheMethod;
  request: string;
  offset?: number;
  length?: number;
  headers?: DictationCacheHeader[];
  dataBase64?: string;
};

function isDictationCacheRequest(message: WorkerMessage): message is DictationCacheRequest {
  return (
    message.type === "cache:request" &&
    typeof (message as DictationCacheRequest).cacheRequestId === "number" &&
    typeof (message as DictationCacheRequest).method === "string" &&
    typeof (message as DictationCacheRequest).request === "string"
  );
}

function requireNumber(value: number | undefined, name: string): number {
  if (typeof value !== "number") throw new Error(`missing ${name}`);
  return value;
}

function requireString(value: string | undefined, name: string): string {
  if (typeof value !== "string") throw new Error(`missing ${name}`);
  return value;
}

function requireHeaders(value: DictationCacheHeader[] | undefined): DictationCacheHeader[] {
  if (!Array.isArray(value)) throw new Error("missing headers");
  return value;
}

async function handleDictationCacheRequest(worker: Worker, message: DictationCacheRequest) {
  try {
    switch (message.method) {
      case "metadata": {
        const metadata = await dictationCacheMetadata(message.request);
        worker.postMessage({
          type: "cache:response",
          cacheRequestId: message.cacheRequestId,
          ok: true,
          metadata,
        });
        return;
      }
      case "read": {
        const offset = requireNumber(message.offset, "offset");
        const length = requireNumber(message.length, "length");
        const dataBase64 = await dictationCacheRead(message.request, offset, length);
        worker.postMessage({
          type: "cache:response",
          cacheRequestId: message.cacheRequestId,
          ok: true,
          dataBase64,
        });
        return;
      }
      case "putStart":
        await dictationCachePutStart(message.request, requireHeaders(message.headers));
        worker.postMessage({ type: "cache:response", cacheRequestId: message.cacheRequestId, ok: true });
        return;
      case "putChunk":
        await dictationCachePutChunk(message.request, requireString(message.dataBase64, "dataBase64"));
        worker.postMessage({ type: "cache:response", cacheRequestId: message.cacheRequestId, ok: true });
        return;
      case "putFinish":
        await dictationCachePutFinish(message.request);
        worker.postMessage({ type: "cache:response", cacheRequestId: message.cacheRequestId, ok: true });
        return;
      case "delete": {
        const deleted = await dictationCacheDelete(message.request);
        worker.postMessage({
          type: "cache:response",
          cacheRequestId: message.cacheRequestId,
          ok: true,
          deleted,
        });
        return;
      }
    }
  } catch (err) {
    worker.postMessage({
      type: "cache:response",
      cacheRequestId: message.cacheRequestId,
      ok: false,
      error: String(err),
    });
  }
}

// One Whisper worker for the whole app, shared by every composer's dictation
// hook. The model loads once into this worker and stays resident, so switching
// composers doesn't spin up a fresh per-composer worker that re-runs the whole
// load. Created lazily on first use and kept alive for the page's lifetime; only
// one dictation runs at a time, so messages route to whichever hook started last.
let sharedWorker: Worker | null = null;
// Whether the model has finished loading in the shared worker. Module-level (not
// per-hook) so a freshly-mounted composer knows the model is already warm and
// skips the loading spinner instead of treating it as a fresh load.
let workerReady = false;
// The active dictation hook's message handler. Set when a hook starts dictation;
// the shared worker dispatches every result/progress/ready message to it.
let activeHandler: ((m: WorkerMessage) => void) | null = null;

function getSharedWorker(): Worker {
  if (sharedWorker) return sharedWorker;
  const worker = new Worker(new URL("./whisperWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as WorkerMessage;
    if (isDictationCacheRequest(m)) {
      void handleDictationCacheRequest(worker, m);
      return;
    }
    // Track readiness here, above any one hook, so it survives the hook that
    // kicked off the load unmounting mid-load — the worker keeps fetching and
    // still reaches 'ready', and the next composer sees a warm model.
    if (m.type === "ready") workerReady = true;
    else if (m.type === "error") workerReady = false;
    activeHandler?.(m);
  };
  // A worker that crashes during module evaluation (transformers import error,
  // WASM fetch blocked by CSP, offline first run) or that receives an unreadable
  // message never posts an "error" message of its own. Without these handlers the
  // active hook would spin in "loading" forever; synthesize an error so it fails
  // and surfaces the problem instead.
  const failWorker = (error: string) => {
    workerReady = false;
    activeHandler?.({ type: "error", error });
  };
  worker.onerror = (event: ErrorEvent) => failWorker(event.message || "dictation worker crashed");
  worker.onmessageerror = () => failWorker("dictation worker received an unreadable message");
  sharedWorker = worker;
  return worker;
}

export function useDictation(target: DictationTarget): Dictation {
  const supported =
    typeof window !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    getAudioCtor() !== null &&
    !!navigator?.mediaDevices?.getUserMedia;

  const [listening, setListening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Mirror of `listening` for async callbacks (worker messages, the capture
  // callback, the post-getUserMedia continuation) that close over stale state.
  const listeningRef = useRef(false);

  // The composer target, refreshed every render so the worker callbacks (bound
  // once) always read the latest value/caret and write through the latest setter.
  const targetRef = useRef(target);
  targetRef.current = target;

  // This hook's handler for messages from the shared worker, rebuilt each render
  // (like applyRef) so the worker — which dispatches to whichever hook started
  // dictation last — always runs the latest closure. Registered as activeHandler
  // in begin().
  const onMessageRef = useRef<(m: WorkerMessage) => void>(() => {});

  // The exact closure this hook installed as the shared worker's `activeHandler`,
  // so teardown can relinquish dispatch only if this hook still owns it (a newer
  // composer may have taken over in the meantime).
  const myHandlerRef = useRef<((m: WorkerMessage) => void) | null>(null);

  // Audio graph + capture buffer.
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);
  const inputRateRef = useRef(TARGET_RATE);
  const chunksRef = useRef<Float32Array[]>([]);
  const lastVoiceRef = useRef(0);
  const lastSentRef = useRef(0);
  const pendingRef = useRef(false);
  const jobRef = useRef(0);
  // The highest jobId whose phrase has been finalized. A result at or below this
  // is stale — its window belongs to a committed phrase — and must be dropped, or
  // it gets appended as a duplicate of the just-finalized sentence.
  const committedJobRef = useRef(0);
  // Truncation guard, the counterpart to committedJobRef's duplication guard.
  // capturedSamplesRef advances every captured frame; voicedSamplesRef marks the
  // furthest point that carried voice; appliedSamplesRef is how far a result we
  // actually wrote reached. All in input-rate samples. A phrase isn't finalized
  // until appliedSamplesRef catches up to voicedSamplesRef — i.e. until everything
  // spoken has been transcribed — so a slow backend can't have the tail reclaimed
  // before it's ever sent.
  const capturedSamplesRef = useRef(0);
  const voicedSamplesRef = useRef(0);
  const appliedSamplesRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Per-file byte counts from the worker's load progress, aggregated into the
  // app-global toast and the mic's percentage.
  const dlFilesRef = useRef<Map<string, { loaded: number; total: number }>>(new Map());

  // Textarea write region: where the in-progress phrase starts in the textarea
  // value (regionStart), how many chars it currently spans (regionLen, what we
  // reselect and overwrite), and a leading space kept when the phrase abuts
  // existing text. 0/'' at the start of a fresh phrase.
  const regionStartRef = useRef(0);
  const regionLenRef = useRef(0);
  const prefixRef = useRef("");
  // The caret captured the instant the mic was clicked (before begin() focuses
  // the field), used to anchor the very first phrase. Sampling it later is
  // unreliable: focusing a textarea that wasn't focused can reset selectionStart
  // to 0, which would prepend the phrase instead of inserting it where the user
  // actually was (or appending at the end of an unfocused field).
  const pendingAnchorRef = useRef<number | null>(null);

  // Held in a ref so the worker's onmessage (bound once) runs the latest closure.
  const applyRef = useRef<(text: string) => void>(() => {});
  applyRef.current = (raw) => {
    const t = targetRef.current;
    // Strip Whisper's bracketed non-speech markers (e.g. "[BLANK_AUDIO]") and
    // collapse whitespace.
    const text = raw
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\([^)]*\)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return;
    const full = t.getText();
    // On a fresh phrase, anchor at the current caret and decide on a leading
    // space so the phrase doesn't run into existing text.
    if (regionLenRef.current === 0) {
      // Prefer the click-time anchor for the first phrase; once it's consumed,
      // later phrases re-read the live caret (which dictation itself controls).
      const anchor = pendingAnchorRef.current ?? t.getCaret();
      pendingAnchorRef.current = null;
      const caret = Math.min(anchor, full.length);
      regionStartRef.current = caret;
      const before = full.slice(0, caret);
      prefixRef.current = before && !/\s$/.test(before) ? " " : "";
    }
    const start = regionStartRef.current;
    const out = prefixRef.current + text;
    // Reselect what we wrote last (regionLen chars from start) and replace it —
    // that's what turns each pass's guess into a live, in-place correction
    // instead of appending duplicates.
    const next = full.slice(0, start) + out + full.slice(start + regionLenRef.current);
    regionLenRef.current = out.length;
    t.setText(next, start + out.length);
  };

  // Finalize the current phrase: lock in what's written, free the audio buffer.
  const commit = () => {
    // Any pass still in flight for this phrase is now stale — mark its job (and
    // every earlier one) so its late result is discarded rather than appended.
    committedJobRef.current = jobRef.current;
    // Leave the written text where it is; the next phrase re-anchors at the caret
    // (which setText left at the end of this phrase) once regionLen is back to 0.
    regionLenRef.current = 0;
    prefixRef.current = "";
    chunksRef.current = [];
    capturedSamplesRef.current = 0;
    voicedSamplesRef.current = 0;
    lastSentRef.current = 0;
    appliedSamplesRef.current = 0;
  };

  const teardownAudio = () => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.port.onmessage = null;
      try {
        processorRef.current.disconnect();
      } catch {
        /* already gone */
      }
    }
    try {
      sourceRef.current?.disconnect();
    } catch {
      /* already gone */
    }
    try {
      sinkRef.current?.disconnect();
    } catch {
      /* already gone */
    }
    for (const tr of streamRef.current?.getTracks() ?? []) tr.stop();
    ctxRef.current?.close().catch(() => {});
    processorRef.current = null;
    sourceRef.current = null;
    sinkRef.current = null;
    streamRef.current = null;
    ctxRef.current = null;
    chunksRef.current = [];
    capturedSamplesRef.current = 0;
    voicedSamplesRef.current = 0;
    lastSentRef.current = 0;
    appliedSamplesRef.current = 0;
    pendingRef.current = false;
    regionStartRef.current = 0;
    regionLenRef.current = 0;
    prefixRef.current = "";
    pendingAnchorRef.current = null;
    // Relinquish the shared worker's dispatch if this hook still owns it, so the
    // worker stops driving a stopped or unmounted composer's handler after
    // teardown. A newer composer that took over keeps its own handler.
    if (activeHandler === myHandlerRef.current) {
      activeHandler = null;
    }
    myHandlerRef.current = null;
  };

  const stop = () => {
    listeningRef.current = false;
    setListening(false);
    setLoading(false);
    teardownAudio();
  };

  // Give up for good and say why. Keeps the worker (and cached model) around.
  const fail = (reason: string) => {
    stop();
    setError(reason);
    if (typeof console !== "undefined") console.warn(`[dictation] stopped: ${reason}`);
  };

  onMessageRef.current = (m) => {
    if (m.type === "progress") {
      const d = m.data;
      if (d?.file && d.status === "progress" && typeof d.total === "number") {
        dlFilesRef.current.set(d.file, { loaded: d.loaded ?? 0, total: d.total });
      } else if (d?.file && d.status === "done") {
        const f = dlFilesRef.current.get(d.file);
        if (f) f.loaded = f.total;
      } else {
        return;
      }
      // Aggregate across the model's files for the global toast + mic percent.
      let loaded = 0;
      let total = 0;
      for (const f of dlFilesRef.current.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      if (total > 0) {
        setProgress(Math.min(100, (loaded / total) * 100));
        setDictationDownload(loaded < total ? { loaded, total } : null);
      }
      return;
    }
    if (m.type === "ready") {
      setLoading(false);
      setProgress(null);
      dlFilesRef.current.clear();
      setDictationDownload(null);
      return;
    }
    if (m.type === "error") {
      if (typeof console !== "undefined") console.warn("[dictation] model load failed:", m.error);
      setDictationDownload(null);
      fail("model");
      return;
    }
    if (m.type === "result") {
      pendingRef.current = false;
      // Drop a result whose window belongs to an already-finalized phrase —
      // applying it now would append a stale duplicate after the committed text.
      if (typeof m.jobId === "number" && m.jobId <= committedJobRef.current) return;
      // Record how far this pass reached (even when it transcribed to nothing)
      // so tick knows the spoken tail has been accounted for before finalizing.
      appliedSamplesRef.current = lastSentRef.current;
      if (listeningRef.current && m.text) applyRef.current(m.text);
    }
  };

  const sendWindow = (totalSamples: number) => {
    const chunks = chunksRef.current;
    const merged = new Float32Array(totalSamples);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    const audio = resampleTo16k(merged, inputRateRef.current);
    lastSentRef.current = totalSamples;
    pendingRef.current = true;
    jobRef.current += 1;
    sharedWorker?.postMessage({ type: "transcribe", jobId: jobRef.current, audio }, [audio.buffer]);
  };

  const tick = () => {
    if (!listeningRef.current) return;
    const chunks = chunksRef.current;
    let total = 0;
    for (const c of chunks) total += c.length;
    if (total === 0) return;
    const now = performance.now();
    const silence = now - lastVoiceRef.current;
    const seconds = total / inputRateRef.current;

    // Treat a shorter gap as a finalizing pause once the phrase has run long, so
    // the live window stays bounded (see LONG_PHRASE_S). Short phrases keep the
    // full 900ms pause so a brief mid-thought hesitation doesn't cut them off.
    const commitGapMs = seconds > LONG_PHRASE_S ? LONG_PHRASE_COMMIT_MS : SILENCE_COMMIT_MS;
    const paused = silence > commitGapMs;

    // A pause before any voice was captured is just leading/standalone silence —
    // drop it so the buffer doesn't fill with it.
    if (paused && voicedSamplesRef.current === 0) {
      commit();
      return;
    }
    // A runaway-long phrase is force-finalized regardless; committedJobRef then
    // drops any pass still in flight for it.
    if (seconds > MAX_WINDOW_S) {
      commit();
      return;
    }
    // A real pause finalizes the phrase — but only once every spoken sample has
    // actually been transcribed and written (appliedSamples has caught up to
    // voicedSamples and nothing's in flight). This also waits out an in-flight
    // pass so its result overwrites in place rather than landing as a duplicate.
    if (paused && !pendingRef.current && appliedSamplesRef.current >= voicedSamplesRef.current) {
      commit();
      return;
    }
    // Otherwise keep transcribing the growing window — when the model's ready, no
    // pass is in flight, and there's new audio since the last send. Once paused,
    // stop re-sending as soon as the spoken tail is covered so trailing silence
    // doesn't keep spinning the backend while we wait to finalize.
    if (!workerReady || pendingRef.current) return;
    if (total <= lastSentRef.current) return;
    if (paused && lastSentRef.current >= voicedSamplesRef.current) return;
    sendWindow(total);
  };

  const begin = async () => {
    setError(null);
    setProgress(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      fail(name === "NotFoundError" || name === "NotReadableError" ? "audio-capture" : "not-allowed");
      return;
    }
    // Toggled off (or unmounted) while the permission prompt was up.
    if (!listeningRef.current) {
      for (const tr of stream.getTracks()) tr.stop();
      return;
    }
    streamRef.current = stream;

    const Ctor = getAudioCtor();
    if (!Ctor) {
      fail("audio-capture");
      return;
    }
    const ctx = new Ctor({ sampleRate: TARGET_RATE });
    ctxRef.current = ctx;
    inputRateRef.current = ctx.sampleRate;
    // The capture node runs as an AudioWorklet (the modern replacement for the
    // deprecated ScriptProcessorNode): a tiny processor module batches the mic's
    // render quanta off the audio thread and posts them here.
    try {
      await ctx.audioWorklet.addModule("/dictation-worklet.js");
    } catch (err) {
      if (typeof console !== "undefined") console.warn("[dictation] worklet load failed:", err);
      fail("audio-capture");
      return;
    }
    // Toggled off (or unmounted) while the worklet module was loading.
    if (!listeningRef.current) {
      for (const tr of stream.getTracks()) tr.stop();
      ctx.close().catch(() => {});
      return;
    }
    const source = ctx.createMediaStreamSource(stream);
    const processor = new AudioWorkletNode(ctx, "dictation-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    processor.port.onmessage = (ev: MessageEvent) => {
      const ch = ev.data as Float32Array;
      let sumSq = 0;
      for (let i = 0; i < ch.length; i++) sumSq += ch[i] * ch[i];
      capturedSamplesRef.current += ch.length;
      if (Math.sqrt(sumSq / ch.length) > VOICE_RMS) {
        lastVoiceRef.current = performance.now();
        voicedSamplesRef.current = capturedSamplesRef.current;
      }
      chunksRef.current.push(ch);
    };
    // Keep the node pulled by the graph; route it through a muted gain so
    // capturing never echoes the mic back to the speakers.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination);
    sourceRef.current = source;
    processorRef.current = processor;
    sinkRef.current = sink;

    lastVoiceRef.current = performance.now();
    lastSentRef.current = 0;
    chunksRef.current = [];
    capturedSamplesRef.current = 0;
    voicedSamplesRef.current = 0;
    appliedSamplesRef.current = 0;
    pendingRef.current = false;
    regionStartRef.current = 0;
    regionLenRef.current = 0;
    prefixRef.current = "";

    // Anchor dictation at the caret even if the mic was clicked from an unfocused
    // composer, then warm up the model and start the transcription loop. Claim the
    // shared worker's messages for this hook, and only show the loading spinner if
    // the model isn't already resident from an earlier composer's use.
    targetRef.current.focus();
    const handler = (m: WorkerMessage) => onMessageRef.current(m);
    myHandlerRef.current = handler;
    activeHandler = handler;
    const worker = getSharedWorker();
    setLoading(!workerReady);
    worker.postMessage({ type: "load" });
    tickRef.current = setInterval(tick, TICK_MS);
  };

  const toggle = () => {
    if (listeningRef.current) {
      stop();
      return;
    }
    if (!supported) return;
    // Sample the anchor now, while the field still holds the focus/caret the user
    // left it with — begin() focuses it a moment later, which can move the caret.
    pendingAnchorRef.current = targetRef.current.getCaret();
    listeningRef.current = true;
    setListening(true);
    void begin();
  };

  // Tear down this composer's audio graph on unmount, but leave the shared worker
  // — and any in-flight model load — alone so the next composer reuses the
  // warm model instead of reloading it.
  useEffect(() => {
    return () => {
      listeningRef.current = false;
      teardownAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { supported, listening, loading, progress, error, toggle, stop };
}
