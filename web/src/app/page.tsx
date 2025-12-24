/* eslint-disable @next/next/no-sync-scripts */
"use client";

import { useEffect, useRef, useState } from "react";

type WsMsg =
  | { type: "transcript"; text: string }
  | { type: "tts_begin"; format: "pcm_s16le"; sample_rate: number }
  | { type: "tts_end" }
  | {
      type: "graph_result";
      pizza_type: string;
      messages: { role: string; content: string }[];
      interrupt?: any;
    }
  | { type: "error"; error: string };

function pcmToWavBlob(pcm: Int16Array, sampleRate: number): Blob {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.byteLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM
  view.setUint16(20, 1, true); // format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer));
  return new Blob([buffer], { type: "audio/wav" });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function bytesToInt16(bytes: Uint8Array): Int16Array {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Int16Array(buf);
}

function bytesToInt16View(bytes: Uint8Array): Int16Array {
  // Fast path: avoid copying when we have even-sized, aligned buffers.
  if (bytes.byteLength % 2 === 0 && bytes.byteOffset % 2 === 0) {
    return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  }
  return bytesToInt16(bytes);
}

export default function Home() {
  const [wsUrl, setWsUrl] = useState("ws://127.0.0.1:8765");
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<string>("idle");
  const [transcript, setTranscript] = useState<string>("");
  const [pizzaType, setPizzaType] = useState<string>("");
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [error, setError] = useState<string>("");
  const [textToSend, setTextToSend] = useState<string>("Can I order a pepperoni pizza?");
  const [ttsStreamStatus, setTtsStreamStatus] = useState<string>("idle");
  const [ttsStreamBufferedMs, setTtsStreamBufferedMs] = useState<number>(0);
  const [ttsStreamChunks, setTtsStreamChunks] = useState<number>(0);
  const [ttsStreamBytes, setTtsStreamBytes] = useState<number>(0);
  const [ttsStreamFrames, setTtsStreamFrames] = useState<number>(0);
  const [ttsOutSampleRate, setTtsOutSampleRate] = useState<number>(0);
  const [ttsStreamMinBufferedMs, setTtsStreamMinBufferedMs] = useState<number>(0);
  const [ttsStreamMaxBufferedMs, setTtsStreamMaxBufferedMs] = useState<number>(0);
  const [ttsStreamUnderruns, setTtsStreamUnderruns] = useState<number>(0);
  const [ttsStreamRebuffers, setTtsStreamRebuffers] = useState<number>(0);
  const [ttsTtftMs, setTtsTtftMs] = useState<number>(0);
  const [ttsTtfbMs, setTtsTtfbMs] = useState<number>(0);
  const [ttsRecordEnabled, setTtsRecordEnabled] = useState<boolean>(true);
  const [ttsRecordedUrl, setTtsRecordedUrl] = useState<string>("");
  const [ttsRecordedFilename, setTtsRecordedFilename] = useState<string>("");
  const [ttsRecordedSampleRate, setTtsRecordedSampleRate] = useState<number>(0);
  const [ttsRecordedDurationMs, setTtsRecordedDurationMs] = useState<number>(0);
  const [ttsRecordedBytes, setTtsRecordedBytes] = useState<number>(0);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string>("default");

  const wsRef = useRef<WebSocket | null>(null);
  const ttsReceivingBinaryRef = useRef<boolean>(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmRef = useRef<Int16Array[]>([]);

  const sampleRate = 16000;

  // ===== Streaming TTS player (AudioWorklet ring buffer) =====
  const ttsCtxRef = useRef<AudioContext | null>(null);
  const ttsSampleRateRef = useRef<number>(24000);
  const ttsStartedRef = useRef<boolean>(false);
  const ttsByteRemainderRef = useRef<Uint8Array>(new Uint8Array(0));
  const ttsPrebufferMs = 2000; // prebuffer before starting playback to absorb jitter
  // Micro rebuffer gate (does not increase initial delay): pause when dangerously low, resume quickly.
  // This trades "choppy clicks" (underruns) for short pauses.
  const ttsLowWaterMs = 20;
  const ttsHighWaterMs = 400;
  // Prevent rapid pause/resume "ticking" by holding a minimum pause duration once we rebuffer.
  const ttsRebufferHoldMs = 150;
  // Prevent frequent tiny pauses by enforcing a minimum time between rebuffers.
  // During cooldown we keep playing unless buffer becomes critically low.
  const ttsRebufferCooldownMs = 2000;
  const ttsEmergencyLowMs = 10;

  const ttsWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
  const ttsWorkletModuleUrlRef = useRef<string>("");
  const ttsWorkletBufferedFramesRef = useRef<number>(0);
  const ttsWorkletUnderrunsRef = useRef<number>(0);
  const ttsWorkletRebuffersRef = useRef<number>(0);
  const ttsWorkletPlayingRef = useRef<boolean>(false);
  const ttsStatsLatchedRef = useRef<boolean>(false);
  const ttsReqStartedAtMsRef = useRef<number>(0);
  const ttsBeginAtMsRef = useRef<number>(0);
  const ttsFirstAudioAtMsRef = useRef<number>(0);

  // Shared ring buffer (SharedArrayBuffer + Atomics) to avoid per-chunk port messaging.
  const ttsSabAudioRef = useRef<SharedArrayBuffer | null>(null);
  const ttsSabCtrlRef = useRef<SharedArrayBuffer | null>(null);
  const ttsSabAudioI16Ref = useRef<Int16Array | null>(null);
  const ttsSabCtrlI32Ref = useRef<Int32Array | null>(null);
  const ttsSabSamplesRef = useRef<number>(0);

  const ttsBufferedMsRef = useRef<number>(0); // updated by interval for UI + min/max
  const ttsMinBufferedMsRef = useRef<number>(Number.POSITIVE_INFINITY);
  const ttsMaxBufferedMsRef = useRef<number>(0);
  const ttsStreamStatusRef = useRef<string>("idle");

  // Recording (capture exactly what we received from the model, before browser resampling).
  const ttsRecordedChunksRef = useRef<Int16Array[]>([]);
  const ttsRecordedSamplesRef = useRef<number>(0);
  const ttsRecordedBuffersRef = useRef<ArrayBuffer[]>([]);
  const ttsRecordedBytesLenRef = useRef<number>(0);
  const ttsStreamBytesRef = useRef<number>(0);
  const ttsStreamChunksRef = useRef<number>(0);
  const ttsStreamFramesRef = useRef<number>(0);
  const ttsRxStartedAtMsRef = useRef<number>(0);
  const ttsRxLastAtMsRef = useRef<number>(0);
  const ttsRxInSamplesRef = useRef<number>(0);
  const [ttsGenRealtimeX, setTtsGenRealtimeX] = useState<number>(0);

  const _ttsOutRate = () => ttsCtxRef.current?.sampleRate ?? ttsSampleRateRef.current;

  const stopTtsStream = (opts?: { resetStats?: boolean }) => {
    const resetStats = opts?.resetStats ?? true;
    ttsStartedRef.current = false;
    ttsByteRemainderRef.current = new Uint8Array(0);
    ttsBufferedMsRef.current = 0;
    ttsSabAudioRef.current = null;
    ttsSabCtrlRef.current = null;
    ttsSabAudioI16Ref.current = null;
    ttsSabCtrlI32Ref.current = null;
    ttsSabSamplesRef.current = 0;
    ttsWorkletBufferedFramesRef.current = 0;
    ttsWorkletPlayingRef.current = false;
    try {
      if (resetStats) {
        ttsWorkletNodeRef.current?.port.postMessage({ type: "reset" });
      } else {
        // Freeze counters after stream end so they don't keep increasing during idle silence.
        ttsWorkletNodeRef.current?.port.postMessage({ type: "stop" });
      }
    } catch {}
    try {
      ttsWorkletNodeRef.current?.disconnect();
    } catch {}
    ttsWorkletNodeRef.current = null;
    setTtsStreamBufferedMs(0);
    if (resetStats) {
      ttsMinBufferedMsRef.current = Number.POSITIVE_INFINITY;
      ttsMaxBufferedMsRef.current = 0;
      setTtsStreamMinBufferedMs(0);
      setTtsStreamMaxBufferedMs(0);
      ttsWorkletUnderrunsRef.current = 0;
      ttsWorkletRebuffersRef.current = 0;
      setTtsStreamUnderruns(0);
      setTtsStreamRebuffers(0);
    }
    setTtsStreamStatus("idle");
  };

  const clearTtsRecording = () => {
    setTtsRecordedUrl("");
    setTtsRecordedFilename("");
    setTtsRecordedSampleRate(0);
    setTtsRecordedDurationMs(0);
    setTtsRecordedBytes(0);
    ttsRecordedChunksRef.current = [];
    ttsRecordedSamplesRef.current = 0;
    ttsRecordedBuffersRef.current = [];
    ttsRecordedBytesLenRef.current = 0;
  };

  const finalizeTtsRecording = () => {
    if (!ttsRecordEnabled) return;
    const sr = ttsRecordedSampleRate || ttsSampleRateRef.current;
    if (!sr) return;

    // Prefer binary-frame recording (zero-copy) when available.
    const bufs = ttsRecordedBuffersRef.current;
    const totalBytes = ttsRecordedBytesLenRef.current;
    let wav: Blob | null = null;
    let durationMs = 0;
    if (bufs.length && totalBytes) {
      const joinedBytes = new Uint8Array(totalBytes);
      let offB = 0;
      for (const b of bufs) {
        joinedBytes.set(new Uint8Array(b), offB);
        offB += b.byteLength;
      }
      // Ensure even bytes for int16.
      const evenLen = joinedBytes.length - (joinedBytes.length % 2);
      const i16 = bytesToInt16View(joinedBytes.subarray(0, evenLen));
      wav = pcmToWavBlob(i16, sr);
      durationMs = (i16.length / sr) * 1000;
    } else {
      const chunks = ttsRecordedChunksRef.current;
      const total = ttsRecordedSamplesRef.current;
      if (!chunks.length || !total) return;
      const joined = new Int16Array(total);
      let off = 0;
      for (const c of chunks) {
        joined.set(c, off);
        off += c.length;
      }
      wav = pcmToWavBlob(joined, sr);
      durationMs = (joined.length / sr) * 1000;
    }
    if (!wav) return;

    const url = URL.createObjectURL(wav);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    setTtsRecordedUrl(url);
    setTtsRecordedFilename(`tts-stream-${ts}.wav`);
    setTtsRecordedBytes(wav.size);
    setTtsRecordedDurationMs(durationMs);
  };

  const ensureTtsWorklet = async (inRate: number) => {
    const ctx = await ensureTtsContext(inRate);
    if (!("audioWorklet" in ctx)) {
      throw new Error("AudioWorklet not supported in this browser.");
    }
    if (ttsWorkletNodeRef.current) return ttsWorkletNodeRef.current;

    if (!ttsWorkletModuleUrlRef.current) {
      // Inline module via Blob URL so it works in a static Next build.
      const moduleCode = `
class TtsPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRate = 24000;
    this.outRate = sampleRate;
    this.sharedCtrl = null;
    this.sharedAudio = null;
    this.ctrl = null; // Int32Array view
    this.audio = null; // Int16Array view (input sample rate)
    this.audioSamples = 0;
    this.underruns = 0;
    this.rebuffers = 0;
    this.playing = false;
    this.startedOnce = false;
    this.enabled = true;
    this.eos = false;
    this.holdFrames = 0;
    this.holdUntil = 0;
    this.cooldownFrames = 0;
    this.cooldownUntil = 0;
    this.emergencyLowFrames = 0;
    this.outCursor = 0;
    this.startFrames = Math.floor(this.outRate * 0.9);
    this.lowFrames = Math.floor(this.outRate * 0.25);
    this.highFrames = Math.floor(this.outRate * 0.75);
    this.rem = new Float32Array(0);
    this.pos = 0;
    this._tick = 0;
    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === "config" && typeof msg.inRate === "number") {
        this.inRate = msg.inRate;
        this.enabled = true;
        this.eos = false;
        if (typeof msg.startFrames === "number") this.startFrames = Math.max(0, msg.startFrames|0);
        if (typeof msg.lowFrames === "number") this.lowFrames = Math.max(0, msg.lowFrames|0);
        if (typeof msg.highFrames === "number") this.highFrames = Math.max(0, msg.highFrames|0);
        if (typeof msg.holdFrames === "number") this.holdFrames = Math.max(0, msg.holdFrames|0);
        if (typeof msg.cooldownFrames === "number") this.cooldownFrames = Math.max(0, msg.cooldownFrames|0);
        if (typeof msg.emergencyLowFrames === "number") this.emergencyLowFrames = Math.max(0, msg.emergencyLowFrames|0);
      } else if (msg.type === "init_shared" && msg.ctrl && msg.audio && typeof msg.audioSamples === "number") {
        this.sharedCtrl = msg.ctrl;
        this.sharedAudio = msg.audio;
        this.ctrl = new Int32Array(this.sharedCtrl);
        this.audio = new Int16Array(this.sharedAudio);
        this.audioSamples = msg.audioSamples|0;
      } else if (msg.type === "eos") {
        // No more input is expected for this stream.
        this.eos = true;
      } else if (msg.type === "stop") {
        this.enabled = false;
        this.playing = false;
      } else if (msg.type === "reset") {
        // Reset counters; the producer/consumer pointers are managed in shared ctrl.
        this.underruns = 0;
        this.rebuffers = 0; this.playing = false; this.enabled = true; this.eos = false;
        this.holdUntil = 0;
        this.cooldownUntil = 0;
        this.outCursor = 0;
        this.rem = new Float32Array(0); this.pos = 0;
      }
    };
  }

  _availableInputSamples(w, r, size) {
    return w >= r ? (w - r) : (size - (r - w));
  }

  _readInputSampleAt(pos) {
    // pos is modulo audioSamples
    return this.audio[pos] / 32768;
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    const frames = out.length;
    this.outCursor += frames;
    if (!this.ctrl || !this.audio || !this.audioSamples) {
      out.fill(0);
      return true;
    }
    if (!this.enabled) {
      out.fill(0);
      this._tick++;
      if ((this._tick % 20) === 0) {
        this.port.postMessage({ type: "stats", bufferedFrames: 0, underruns: this.underruns, rebuffers: this.rebuffers, playing: this.playing });
      }
      return true;
    }
    // Once stream ended and buffer drained, stop processing (and stop counting underruns).
    const w0 = Atomics.load(this.ctrl, 0);
    const r0 = Atomics.load(this.ctrl, 1);
    const avail0 = this._availableInputSamples(w0, r0, this.audioSamples);
    if (this.eos && avail0 <= 0) {
      this.enabled = false;
      this.playing = false;
      out.fill(0);
      this._tick++;
      if ((this._tick % 20) === 0) {
        this.port.postMessage({ type: "stats", bufferedFrames: 0, underruns: this.underruns, rebuffers: this.rebuffers, playing: this.playing });
      }
      return true;
    }
    // Jitter buffer gating: don't start until we have startFrames buffered.
    // If we drop below lowFrames, pause until we refill above highFrames.
    if (!this.playing) {
      const bufferedFrames = Math.floor((avail0 * this.outRate) / this.inRate);
      // After a rebuffer, enforce a minimum pause duration to avoid "ticking".
      const holdActive = this.startedOnce && this.outCursor < this.holdUntil;
      const startThreshold = this.startedOnce && this.highFrames > 0 ? this.highFrames : this.startFrames;
      if (bufferedFrames >= startThreshold || (startThreshold === 0 && bufferedFrames > 0)) {
        if (!holdActive) {
          this.playing = true;
          this.startedOnce = true;
          if (this.cooldownFrames > 0) this.cooldownUntil = this.outCursor + this.cooldownFrames;
        }
      } else {
        out.fill(0);
        this._tick++;
        if ((this._tick % 20) === 0) {
          this.port.postMessage({ type: "stats", bufferedFrames, underruns: this.underruns, rebuffers: this.rebuffers, playing: this.playing });
        }
        return true;
      }
      if (!this.playing) {
        out.fill(0);
        return true;
      }
    }
    const bufferedFramesNow = Math.floor((avail0 * this.outRate) / this.inRate);
    if (this.lowFrames > 0 && bufferedFramesNow < this.lowFrames) {
      const inCooldown = this.cooldownFrames > 0 && this.outCursor < this.cooldownUntil;
      const emergency = this.emergencyLowFrames > 0 && bufferedFramesNow <= this.emergencyLowFrames;
      if (inCooldown && !emergency) {
        // During cooldown we prefer to keep playing (fewer pauses). If we truly starve, we'll
        // hit emergency and pause, or ultimately underrun.
      } else {
      this.playing = false;
      this.rebuffers++;
      if (this.holdFrames > 0) this.holdUntil = this.outCursor + this.holdFrames;
      out.fill(0);
      this._tick++;
      if ((this._tick % 20) === 0) {
        this.port.postMessage({ type: "stats", bufferedFrames: bufferedFramesNow, underruns: this.underruns, rebuffers: this.rebuffers, playing: this.playing });
      }
      return true;
      }
    }
    // If we were paused and refilled enough, resume.
    if (!this.playing && this.highFrames > 0 && bufferedFramesNow >= this.highFrames) {
      this.playing = true;
    }
    // Resample directly from shared input ring into output.
    let w = w0;
    let r = r0;
    let avail = avail0;
    const step = this.inRate / this.outRate; // input samples per output sample
    let frac = this.pos;
    // Ensure we have at least 2 samples for interpolation.
    if (avail < 2) {
      out.fill(0);
      this.underruns++;
      this._tick++;
      if ((this._tick % 20) === 0) {
        const bf = Math.floor((avail * this.outRate) / this.inRate);
        this.port.postMessage({ type: "stats", bufferedFrames: bf, underruns: this.underruns, rebuffers: this.rebuffers, playing: this.playing });
      }
      return true;
    }
    // Prime s0/s1 from current read position.
    let s0 = this._readInputSampleAt(r);
    let s1 = this._readInputSampleAt((r + 1) % this.audioSamples);
    // We'll consume input by advancing r as needed when frac crosses 1.0
    for (let i = 0; i < frames; i++) {
      out[i] = s0 + (s1 - s0) * frac;
      frac += step;
      while (frac >= 1.0) {
        frac -= 1.0;
        // consume one input sample: advance r by 1
        r = (r + 1) % this.audioSamples;
        avail -= 1;
        if (avail < 1) {
          // no next sample available
          out.fill(0, i + 1);
          this.underruns++;
          break;
        }
        s0 = s1;
        s1 = this._readInputSampleAt((r + 1) % this.audioSamples);
      }
      if (avail < 1) break;
    }
    this.pos = frac;
    Atomics.store(this.ctrl, 1, r);
    this._tick++;
    if ((this._tick % 20) === 0) {
      const w1 = Atomics.load(this.ctrl, 0);
      const r1 = Atomics.load(this.ctrl, 1);
      const avail1 = this._availableInputSamples(w1, r1, this.audioSamples);
      const bufferedFrames = Math.floor((avail1 * this.outRate) / this.inRate);
      this.port.postMessage({ type: "stats", bufferedFrames, underruns: this.underruns, rebuffers: this.rebuffers, playing: this.playing });
    }
    return true;
  }
}
registerProcessor("tts-player", TtsPlayerProcessor);
`;
      const blob = new Blob([moduleCode], { type: "text/javascript" });
      ttsWorkletModuleUrlRef.current = URL.createObjectURL(blob);
    }

    await ctx.audioWorklet.addModule(ttsWorkletModuleUrlRef.current);
    const node = new AudioWorkletNode(ctx, "tts-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === "stats") {
        if (typeof msg.bufferedFrames === "number") ttsWorkletBufferedFramesRef.current = msg.bufferedFrames;
        if (typeof msg.underruns === "number") ttsWorkletUnderrunsRef.current = msg.underruns;
        if (typeof msg.rebuffers === "number") ttsWorkletRebuffersRef.current = msg.rebuffers;
        if (typeof msg.playing === "boolean") ttsWorkletPlayingRef.current = msg.playing;
      }
    };
    node.connect(ctx.destination);
    const startFrames = Math.max(0, Math.floor((ctx.sampleRate * ttsPrebufferMs) / 1000));
    const lowFrames = Math.max(0, Math.floor((ctx.sampleRate * ttsLowWaterMs) / 1000));
    const highFrames = Math.max(lowFrames, Math.floor((ctx.sampleRate * ttsHighWaterMs) / 1000));
    const holdFrames = Math.max(0, Math.floor((ctx.sampleRate * ttsRebufferHoldMs) / 1000));
    const cooldownFrames = Math.max(0, Math.floor((ctx.sampleRate * ttsRebufferCooldownMs) / 1000));
    const emergencyLowFrames = Math.max(0, Math.floor((ctx.sampleRate * ttsEmergencyLowMs) / 1000));
    node.port.postMessage({
      type: "config",
      inRate,
      startFrames,
      lowFrames,
      highFrames,
      holdFrames,
      cooldownFrames,
      emergencyLowFrames,
    });
    ttsWorkletNodeRef.current = node;
    return node;
  };

  const ensureSharedRing = (inRate: number) => {
    // 12s ring at input sample rate; enough to absorb jitter without being huge.
    const seconds = 12;
    const samples = Math.max(1, Math.floor(inRate * seconds));
    if (ttsSabAudioRef.current && ttsSabSamplesRef.current === samples) return;
    // Require cross-origin isolation for SharedArrayBuffer.
    if (typeof SharedArrayBuffer === "undefined" || !(globalThis as any).crossOriginIsolated) {
      throw new Error(
        "SharedArrayBuffer unavailable. Ensure COOP/COEP headers are set (crossOriginIsolated=true)."
      );
    }
    ttsSabSamplesRef.current = samples;
    ttsSabAudioRef.current = new SharedArrayBuffer(samples * 2);
    ttsSabCtrlRef.current = new SharedArrayBuffer(8); // 2x int32: writePos, readPos
    ttsSabAudioI16Ref.current = new Int16Array(ttsSabAudioRef.current);
    ttsSabCtrlI32Ref.current = new Int32Array(ttsSabCtrlRef.current);
    Atomics.store(ttsSabCtrlI32Ref.current, 0, 0);
    Atomics.store(ttsSabCtrlI32Ref.current, 1, 0);
  };

  const writeToSharedRing = (pcmBuf: ArrayBuffer) => {
    const ring = ttsSabAudioI16Ref.current;
    const ctrl = ttsSabCtrlI32Ref.current;
    if (!ring || !ctrl) return;
    const src = new Int16Array(pcmBuf);
    const size = ring.length;
    let w = Atomics.load(ctrl, 0);
    let r = Atomics.load(ctrl, 1);
    const avail = w >= r ? (w - r) : (size - (r - w));
    let free = size - avail - 1;
    // If overflow, drop oldest by advancing read pointer.
    if (src.length > free) {
      const drop = src.length - free;
      r = (r + drop) % size;
      Atomics.store(ctrl, 1, r);
      free += drop;
    }
    const toWrite = Math.min(src.length, free);
    const first = Math.min(toWrite, size - w);
    ring.set(src.subarray(0, first), w);
    const remain = toWrite - first;
    if (remain > 0) ring.set(src.subarray(first, first + remain), 0);
    w = (w + toWrite) % size;
    Atomics.store(ctrl, 0, w);
  };

  // No per-chunk AudioWorklet messaging path: we write into the SharedArrayBuffer ring.

  useEffect(() => {
    ttsStreamStatusRef.current = ttsStreamStatus;
  }, [ttsStreamStatus]);

  // Revoke old recorded URLs to avoid leaks.
  const prevTtsRecordedUrlRef = useRef<string>("");
  useEffect(() => {
    const prev = prevTtsRecordedUrlRef.current;
    if (prev && prev !== ttsRecordedUrl) URL.revokeObjectURL(prev);
    prevTtsRecordedUrlRef.current = ttsRecordedUrl;
    return () => {
      if (ttsRecordedUrl) URL.revokeObjectURL(ttsRecordedUrl);
    };
  }, [ttsRecordedUrl]);

  const ensureTtsContext = async (_sr: number) => {
    if (ttsCtxRef.current) return ttsCtxRef.current;
    // Prefer browser default sample rate (usually 48k). We'll resample incoming 24k PCM.
    ttsCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    setTtsOutSampleRate(ttsCtxRef.current.sampleRate);
    return ttsCtxRef.current!;
  };

  const primeTtsAudio = async () => {
    const ctx = await ensureTtsContext(ttsSampleRateRef.current);
    if (ctx.state !== "running") {
      await ctx.resume();
    }
  };

  // Update buffered-ms UI outside the audio callback to avoid glitching playback.
  useEffect(() => {
    const id = window.setInterval(() => {
      const ctx = ttsCtxRef.current;
      const outRate = ctx?.sampleRate ?? _ttsOutRate();
      const bufferedFrames = ttsWorkletBufferedFramesRef.current || 0;
      const ms = outRate ? (bufferedFrames / outRate) * 1000 : 0;
      ttsBufferedMsRef.current = ms;
      setTtsStreamBufferedMs(ms);
      // Throttle stats updates: updating React state per audio frame can cause main-thread stalls.
      setTtsStreamBytes(ttsStreamBytesRef.current);
      setTtsStreamChunks(ttsStreamChunksRef.current);
      setTtsStreamFrames(ttsStreamFramesRef.current);
      // Keep these visible after the stream ends (idle) for debugging.
      if (ttsStreamStatusRef.current !== "idle" || ttsWorkletNodeRef.current) {
        if (!ttsStatsLatchedRef.current) {
          setTtsStreamUnderruns(ttsWorkletUnderrunsRef.current || 0);
          setTtsStreamRebuffers(ttsWorkletRebuffersRef.current || 0);
        }
      }
      // Generation speed: (audio seconds produced) / (wall clock seconds elapsed).
      // Freeze once the stream ends so it doesn't drift while idle/draining.
      if (
        ttsStreamStatusRef.current !== "idle" &&
        ttsRxStartedAtMsRef.current > 0 &&
        ttsRxLastAtMsRef.current >= ttsRxStartedAtMsRef.current &&
        ttsSampleRateRef.current > 0
      ) {
        const elapsedS = Math.max(
          0.001,
          (ttsRxLastAtMsRef.current - ttsRxStartedAtMsRef.current) / 1000
        );
        const audioS = ttsRxInSamplesRef.current / ttsSampleRateRef.current;
        setTtsGenRealtimeX(audioS / elapsedS);
      }
      // Track min/max only while actually playing (otherwise initial prebuffer would force min=0).
      if (
        ttsStreamStatusRef.current !== "idle" &&
        ttsWorkletPlayingRef.current &&
        bufferedFrames > 0
      ) {
        ttsMinBufferedMsRef.current = Math.min(ttsMinBufferedMsRef.current, ms);
        ttsMaxBufferedMsRef.current = Math.max(ttsMaxBufferedMsRef.current, ms);
        setTtsStreamMinBufferedMs(
          Number.isFinite(ttsMinBufferedMsRef.current) ? ttsMinBufferedMsRef.current : 0
        );
        setTtsStreamMaxBufferedMs(ttsMaxBufferedMsRef.current);
      }
    }, 200);
    return () => window.clearInterval(id);
  }, []);

  const connect = () => {
    setError("");
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      wsRef.current = ws;
      setConnected(true);
      setStatus("connected");
    };
    ws.onclose = () => {
      setConnected(false);
      setStatus("disconnected");
    };
    ws.onerror = () => setError("WebSocket error");
    ws.onmessage = (evt) => {
      try {
        // TTS audio chunks can arrive as binary frames (ArrayBuffer) to avoid base64 overhead.
        if (typeof evt.data !== "string") {
          if (!ttsReceivingBinaryRef.current) return;
          const handleBuffer = (buf: ArrayBuffer) => {
            const len = buf.byteLength;
            if (!len) return;
            ttsStreamBytesRef.current += len;
            ttsStreamChunksRef.current += 1;
            ttsRxLastAtMsRef.current = Date.now();
            if (ttsFirstAudioAtMsRef.current === 0) {
              ttsFirstAudioAtMsRef.current = ttsRxLastAtMsRef.current;
              if (ttsReqStartedAtMsRef.current > 0) {
                setTtsTtfbMs(ttsFirstAudioAtMsRef.current - ttsReqStartedAtMsRef.current);
              }
            }
            const inRate = ttsSampleRateRef.current || 24000;
            const outRate = ttsCtxRef.current?.sampleRate ?? 48000;
            const inSamples = Math.floor(len / 2);
            ttsRxInSamplesRef.current += inSamples;
            ttsStreamFramesRef.current += Math.round((inSamples * outRate) / inRate);

            // Recording: keep a copy so we can transfer the original buffer to the worklet.
            if (ttsRecordEnabled) {
              const copy = buf.slice(0);
              ttsRecordedBuffersRef.current.push(copy);
              ttsRecordedBytesLenRef.current += copy.byteLength;
            }
            // Feed the SAB ring directly (no per-chunk port messaging).
            writeToSharedRing(buf);
          };

          if (evt.data instanceof ArrayBuffer) {
            handleBuffer(evt.data);
            return;
          }
          if (evt.data instanceof Blob) {
            void evt.data.arrayBuffer().then((buf) => handleBuffer(buf));
            return;
          }
          return;
        }

        const msg = JSON.parse(evt.data) as WsMsg;
        if (msg.type === "transcript") setTranscript(msg.text);
        if (msg.type === "tts_begin") {
          stopTtsStream({ resetStats: true });
          ttsStatsLatchedRef.current = false;
          ttsSampleRateRef.current = msg.sample_rate;
          ttsReceivingBinaryRef.current = true;
          ttsBeginAtMsRef.current = Date.now();
          ttsFirstAudioAtMsRef.current = 0;
          if (ttsReqStartedAtMsRef.current > 0) {
            setTtsTtftMs(ttsBeginAtMsRef.current - ttsReqStartedAtMsRef.current);
          } else {
            setTtsTtftMs(0);
          }
          setTtsTtfbMs(0);
          setTtsStreamStatus("buffering");
          ttsStreamChunksRef.current = 0;
          ttsStreamBytesRef.current = 0;
          ttsStreamFramesRef.current = 0;
          ttsRxStartedAtMsRef.current = Date.now();
          ttsRxLastAtMsRef.current = ttsRxStartedAtMsRef.current;
          ttsRxInSamplesRef.current = 0;
          setTtsStreamChunks(0);
          setTtsStreamBytes(0);
          setTtsStreamFrames(0);
          ttsMinBufferedMsRef.current = Number.POSITIVE_INFINITY;
          ttsMaxBufferedMsRef.current = 0;
          setTtsStreamMinBufferedMs(0);
          setTtsStreamMaxBufferedMs(0);
          ttsWorkletUnderrunsRef.current = 0;
          ttsWorkletRebuffersRef.current = 0;
          setTtsStreamUnderruns(0);
          setTtsStreamRebuffers(0);
          if (ttsRecordEnabled) {
            clearTtsRecording();
            setTtsRecordedSampleRate(msg.sample_rate);
          }
          // Ensure AudioContext exists (even if suspended).
          void ensureTtsContext(ttsSampleRateRef.current);
          // SAB ring + worklet init (requires COOP/COEP -> crossOriginIsolated).
          try {
            ensureSharedRing(msg.sample_rate);
            void ensureTtsWorklet(msg.sample_rate)
              .then((node) => {
                node.port.postMessage({
                  type: "init_shared",
                  ctrl: ttsSabCtrlRef.current,
                  audio: ttsSabAudioRef.current,
                  audioSamples: ttsSabSamplesRef.current,
                });
              })
              .catch((e) => setError(e?.message || "Failed to init AudioWorklet"));
          } catch (e: any) {
            setError(
              e?.message ||
                "SharedArrayBuffer unavailable. Ensure COOP/COEP headers are set (crossOriginIsolated=true)."
            );
          }
        }
        if (msg.type === "tts_end") {
          // Drain: keep playing until queue is empty; then stop the processor.
          setTtsStreamStatus("draining");
          ttsReceivingBinaryRef.current = false;
          // Clear any odd-byte remainder just in case.
          ttsByteRemainderRef.current = new Uint8Array(0);
          // Tell the worklet no more input is expected; it will stop itself once drained.
          try {
            ttsWorkletNodeRef.current?.port.postMessage({ type: "eos" });
          } catch {}
          // Latch final counters to avoid late worklet stats overwriting UI during/after draining.
          ttsStatsLatchedRef.current = true;
          setTtsStreamUnderruns(ttsWorkletUnderrunsRef.current || 0);
          setTtsStreamRebuffers(ttsWorkletRebuffersRef.current || 0);
          if (ttsReqStartedAtMsRef.current > 0 && ttsBeginAtMsRef.current > 0) {
            setTtsTtftMs(ttsBeginAtMsRef.current - ttsReqStartedAtMsRef.current);
          }
          if (ttsReqStartedAtMsRef.current > 0 && ttsFirstAudioAtMsRef.current > 0) {
            setTtsTtfbMs(ttsFirstAudioAtMsRef.current - ttsReqStartedAtMsRef.current);
          }
          // Capture a WAV of exactly what we received from the model.
          finalizeTtsRecording();
          const check = setInterval(() => {
            const ctx = ttsCtxRef.current;
            const outRate = ctx?.sampleRate ?? _ttsOutRate();
            const bufferedFrames = ttsWorkletBufferedFramesRef.current || 0;
            const ms = outRate ? (bufferedFrames / outRate) * 1000 : 0;
            if (ttsStartedRef.current && ms <= 5) {
              // Auto-finish: keep min/max visible for debugging; only clear on next tts_begin or manual stop.
              stopTtsStream({ resetStats: false });
              clearInterval(check);
            }
          }, 200);
        }
        if (msg.type === "graph_result") {
          setPizzaType(msg.pizza_type);
          setMessages(msg.messages);
          if (msg.interrupt) {
            setMessages((prev) => [
              ...prev,
              { role: "interrupt", content: JSON.stringify(msg.interrupt) },
            ]);
          }
        }
        if (msg.type === "error") setError(msg.error);
      } catch (e) {
        console.error("WS message handling failed:", e);
      }
    };
  };

  const disconnect = () => {
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  };

  const startRecording = async () => {
    setError("");
    // Don't clear conversation/state when starting a new recording.
    // The conversation will update when we send the audio and receive a graph result.
    setTranscript("");
    pcmRef.current = [];

    if (!connected || !wsRef.current) {
      setError("Connect to WS server first.");
      return;
    }

    setStatus("requesting mic…");
    try {
      const constraints: MediaStreamConstraints =
        micDeviceId && micDeviceId !== "default"
          ? { audio: { deviceId: { exact: micDeviceId } } }
          : { audio: true };
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err: any) {
        // Fallback to default device if the chosen device disappeared.
        if (micDeviceId && micDeviceId !== "default") {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          setMicDeviceId("default");
        } else {
          throw err;
        }
      }
      mediaStreamRef.current = stream;
    } catch (e: any) {
      setStatus("mic permission denied");
      setError(e?.message || "Microphone permission denied/unavailable in this browser.");
      return;
    }
    const stream = mediaStreamRef.current!;

    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    audioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);

    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    source.connect(processor);
    processor.connect(audioCtx.destination);

    setStatus("recording");

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const inRate = e.inputBuffer.sampleRate;
      const ratio = inRate / sampleRate;
      const outLen = Math.floor(input.length / ratio);
      const out = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const idx = Math.floor(i * ratio);
        const s = Math.max(-1, Math.min(1, input[idx]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      pcmRef.current.push(out);
    };
  };

  const stopAndSend = async () => {
    setStatus("stopping");
    processorRef.current?.disconnect();
    processorRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;

    const chunks = pcmRef.current;
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const joined = new Int16Array(total);
    let offset = 0;
    for (const c of chunks) {
      joined.set(c, offset);
      offset += c.length;
    }

    const wav = pcmToWavBlob(joined, sampleRate);
    const b64 = await blobToBase64(wav);

    setStatus("sending");
    wsRef.current?.send(JSON.stringify({ type: "audio_wav_b64", audio_b64: b64 }));
    setStatus("sent (awaiting response)");
  };

  useEffect(() => {
    return () => {
      disconnect();
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioCtxRef.current?.close();
      if (ttsWorkletModuleUrlRef.current) {
        try {
          URL.revokeObjectURL(ttsWorkletModuleUrlRef.current);
        } catch {}
        ttsWorkletModuleUrlRef.current = "";
      }
      ttsCtxRef.current?.close();
    };
  }, []);

  const sendText = () => {
    setError("");
    if (!connected || !wsRef.current) {
      setError("Connect to WS server first.");
      return;
    }
    ttsReqStartedAtMsRef.current = Date.now();
    ttsBeginAtMsRef.current = 0;
    ttsFirstAudioAtMsRef.current = 0;
    setTtsTtftMs(0);
    setTtsTtfbMs(0);
    wsRef.current.send(JSON.stringify({ type: "text", text: textToSend }));
  };

  const speakStream = () => {
    setError("");
    if (!connected || !wsRef.current) {
      setError("Connect to WS server first.");
      return;
    }
    ttsReqStartedAtMsRef.current = Date.now();
    ttsBeginAtMsRef.current = 0;
    ttsFirstAudioAtMsRef.current = 0;
    setTtsTtftMs(0);
    setTtsTtfbMs(0);
    // Prime audio inside the click handler (user gesture) so playback isn't blocked.
    void primeTtsAudio();
    wsRef.current.send(JSON.stringify({ type: "tts_text", text: textToSend }));
  };

  const sendWavFile = async (file: File) => {
    setError("");
    if (!connected || !wsRef.current) {
      setError("Connect to WS server first.");
      return;
    }
    ttsReqStartedAtMsRef.current = Date.now();
    ttsBeginAtMsRef.current = 0;
    ttsFirstAudioAtMsRef.current = 0;
    setTtsTtftMs(0);
    setTtsTtfbMs(0);
    const b64 = await blobToBase64(file);
    wsRef.current.send(JSON.stringify({ type: "audio_wav_b64", audio_b64: b64 }));
  };

  useEffect(() => {
    const loadDevices = async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMicDevices(devices.filter((d) => d.kind === "audioinput"));
      } catch {
        // ignore
      }
    };
    void loadDevices();
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 pb-28">
      <div className="mx-auto max-w-3xl px-6 py-10 space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold">Voice Agents (Web)</h1>
          <p className="text-zinc-300">
            Record audio in the browser, send it to the Python WS server, and display the agent output.
          </p>
        </header>

        <section className="rounded-xl border border-zinc-800 p-5 space-y-4">
          <div className="flex flex-col gap-2">
            <label className="text-sm text-zinc-400">WebSocket URL</label>
            <input
              className="rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm"
              value={wsUrl}
              onChange={(e) => setWsUrl(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-zinc-400">Microphone</label>
            <select
              className="rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm"
              value={micDeviceId}
              onChange={(e) => setMicDeviceId(e.target.value)}
            >
              <option value="default">Default</option>
              {micDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Mic (${d.deviceId.slice(0, 8)}…)`}
                </option>
              ))}
            </select>
            <div className="text-xs text-zinc-500">
              If you see “Requested device not found”, pick “Default” or re-select your mic.
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <button
              className="rounded-md bg-zinc-100 text-zinc-900 px-3 py-2 text-sm disabled:opacity-50"
              onClick={connect}
              disabled={connected}
            >
              Connect
            </button>
            <button
              className="rounded-md border border-zinc-700 px-3 py-2 text-sm disabled:opacity-50"
              onClick={disconnect}
              disabled={!connected}
            >
              Disconnect
            </button>
          </div>

          <div className="text-sm text-zinc-400">
            Status: <span className="text-zinc-200">{status}</span> | Connected:{" "}
            <span className="text-zinc-200">{String(connected)}</span>
          </div>

          {error ? (
            <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}
        </section>

        <details className="rounded-xl border border-zinc-800 p-5 space-y-4">
          <summary className="font-semibold cursor-pointer select-none">
            Quick Test (No Mic Needed)
            <span className="ml-2 text-xs text-zinc-500 font-normal">
              (expand)
            </span>
          </summary>
          <div className="flex flex-col gap-2">
            <label className="text-sm text-zinc-400">Send text into the agent graph</label>
            <textarea
              className="min-h-[72px] rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm"
              value={textToSend}
              onChange={(e) => setTextToSend(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                className="rounded-md bg-zinc-100 text-zinc-900 px-3 py-2 text-sm disabled:opacity-50"
                onClick={sendText}
                disabled={!connected}
              >
                Send Text
              </button>
              <button
                className="rounded-md border border-zinc-700 px-3 py-2 text-sm disabled:opacity-50"
                onClick={speakStream}
                disabled={!connected}
              >
                Stream TTS Only
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-zinc-400">Upload a WAV file to transcribe + run graph</label>
            <input
              className="text-sm"
              type="file"
              accept="audio/wav"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void sendWavFile(f);
              }}
              disabled={!connected}
            />
            <p className="text-xs text-zinc-500">
              Tip: This is the easiest way to validate audio in environments where mic permissions aren’t available.
            </p>
          </div>
        </details>

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-zinc-800 p-5 space-y-2">
            <h2 className="font-semibold">Transcript</h2>
            <div className="text-sm text-zinc-200 whitespace-pre-wrap">{transcript || "(none yet)"}</div>
          </div>
          <div className="rounded-xl border border-zinc-800 p-5 space-y-2">
            <h2 className="font-semibold">Extracted State</h2>
            <div className="text-sm text-zinc-200">pizza_type: {pizzaType || "(not extracted)"}</div>
          </div>
        </section>

        <section className="rounded-xl border border-zinc-800 p-5 space-y-2">
          <h2 className="font-semibold">Playback</h2>
          <div className="text-xs text-zinc-400">
            TTS stream: <span className="text-zinc-200">{ttsStreamStatus}</span> | buffered:{" "}
            <span className="text-zinc-200">{ttsStreamBufferedMs.toFixed(0)}ms</span>
            {" "} | min/max:{" "}
            <span className="text-zinc-200">
              {ttsStreamMinBufferedMs.toFixed(0)}ms / {ttsStreamMaxBufferedMs.toFixed(0)}ms
            </span>
            {" "} | underruns: <span className="text-zinc-200">{ttsStreamUnderruns}</span>
            {" "} | rebuffers: <span className="text-zinc-200">{ttsStreamRebuffers}</span>
            {" "} | gen x: <span className="text-zinc-200">{ttsGenRealtimeX.toFixed(2)}</span>
            {" "} | ttft: <span className="text-zinc-200">{ttsTtftMs ? `${ttsTtftMs}ms` : "-"}</span>
            {" "} | ttfb: <span className="text-zinc-200">{ttsTtfbMs ? `${ttsTtfbMs}ms` : "-"}</span>
            {" "} | chunks: <span className="text-zinc-200">{ttsStreamChunks}</span>
            {" "} | bytes: <span className="text-zinc-200">{ttsStreamBytes}</span>
            {" "} | frames: <span className="text-zinc-200">{ttsStreamFrames}</span>
            {" "} | outHz: <span className="text-zinc-200">{ttsOutSampleRate || "-"}</span>
          </div>
          <details className="pt-1">
            <summary className="cursor-pointer select-none text-sm text-zinc-300">
              Playback controls
              <span className="ml-2 text-xs text-zinc-500">(expand)</span>
            </summary>
            <div className="pt-3 space-y-2">
              <button
                className="rounded-md border border-zinc-700 px-3 py-2 text-sm w-fit"
                onClick={() => stopTtsStream({ resetStats: true })}
              >
                Stop playback
              </button>

              <div className="pt-2 border-t border-zinc-800">
                <div className="text-sm text-zinc-200 font-medium">Stream recording</div>
                <label className="mt-2 flex items-center gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={ttsRecordEnabled}
                    onChange={(e) => setTtsRecordEnabled(e.target.checked)}
                  />
                  Record streamed TTS to WAV (captures exactly what the model sent)
                </label>

                {ttsRecordedUrl ? (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs text-zinc-400">
                      Recorded:{" "}
                      <span className="text-zinc-200">
                        {(ttsRecordedDurationMs / 1000).toFixed(2)}s
                      </span>{" "}
                      @ <span className="text-zinc-200">{ttsRecordedSampleRate || "-"}</span> Hz •{" "}
                      <span className="text-zinc-200">{ttsRecordedBytes}</span> bytes
                    </div>
                    <audio src={ttsRecordedUrl} controls className="w-full" />
                    <div className="flex gap-2 flex-wrap">
                      <a
                        className="rounded-md border border-zinc-700 px-3 py-2 text-sm w-fit"
                        href={ttsRecordedUrl}
                        download={ttsRecordedFilename || "tts-stream.wav"}
                      >
                        Download recorded WAV
                      </a>
                      <button
                        className="rounded-md border border-zinc-700 px-3 py-2 text-sm w-fit"
                        onClick={clearTtsRecording}
                      >
                        Clear recording
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 text-xs text-zinc-500">
                    No recording yet. Run “stream tts only” to generate one.
                  </div>
                )}
              </div>
            </div>
          </details>
        </section>

        <section className="rounded-xl border border-zinc-800 p-5 space-y-3">
          <h2 className="font-semibold">Conversation</h2>
          <div className="space-y-2">
            {messages.length ? (
              messages.map((m, i) => (
                <div key={i} className="rounded-md bg-zinc-900 border border-zinc-800 p-3">
                  <div className="text-xs text-zinc-400">{m.role}</div>
                  <div className="text-sm text-zinc-100 whitespace-pre-wrap">{m.content}</div>
                </div>
              ))
            ) : (
              <div className="text-sm text-zinc-300">(no messages yet)</div>
            )}
          </div>
        </section>
      </div>

      {/* Bottom recording controls */}
      <div className="fixed inset-x-0 bottom-0 border-t border-zinc-800 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto max-w-3xl px-6 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-zinc-400">
            Recording controls • Status: <span className="text-zinc-200">{status}</span>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              className="rounded-md bg-emerald-500 text-black px-3 py-2 text-sm disabled:opacity-50"
              onClick={startRecording}
              disabled={!connected || status === "recording"}
            >
              Start Recording
            </button>
            <button
              className="rounded-md bg-amber-500 text-black px-3 py-2 text-sm disabled:opacity-50"
              onClick={stopAndSend}
              disabled={!connected || status !== "recording"}
            >
              Stop & Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
