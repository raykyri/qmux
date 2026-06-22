// Mic-capture worklet for dictation (see src/useDictation.ts). Forwards the
// first input channel to the main thread, batched to ~4096-sample chunks (the
// buffer size the old ScriptProcessorNode used) so the port isn't messaged for
// every 128-sample render quantum. All buffering, voice-activity gating, and
// resampling stay on the main thread. Served from /public as plain JS:
// audioWorklet.addModule() loads it by URL, outside the Vite module graph.
const BATCH_SAMPLES = 4096;

class DictationCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BATCH_SAMPLES);
    this.len = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch || ch.length === 0) return true;
    let off = 0;
    while (off < ch.length) {
      const n = Math.min(ch.length - off, BATCH_SAMPLES - this.len);
      this.buf.set(ch.subarray(off, off + n), this.len);
      this.len += n;
      off += n;
      if (this.len === BATCH_SAMPLES) {
        const out = this.buf;
        this.buf = new Float32Array(BATCH_SAMPLES);
        this.len = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('dictation-capture', DictationCaptureProcessor);
