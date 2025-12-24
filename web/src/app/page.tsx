/* eslint-disable @next/next/no-sync-scripts */
"use client";

import { useEffect, useRef, useState } from "react";

type WsMsg =
  | { type: "transcript"; text: string }
  | { type: "tts_begin"; format: "pcm_s16le"; sample_rate: number }
  | { type: "tts_chunk"; seq: number; audio_b64: string }
  | { type: "tts_end" }
  | { type: "tts_audio"; format: "wav"; sample_rate: number; audio_b64: string }
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

async function base64ToBlob(b64: string, mime: string): Promise<Blob> {
  // Avoid `atob` size limits by using a data URL + fetch.
  const res = await fetch(`data:${mime};base64,${b64}`);
  return await res.blob();
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToInt16(bytes: Uint8Array): Int16Array {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Int16Array(buf);
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
  const [audioUrl, setAudioUrl] = useState<string>("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [ttsStreamStatus, setTtsStreamStatus] = useState<string>("idle");
  const [ttsStreamBufferedMs, setTtsStreamBufferedMs] = useState<number>(0);
  const [ttsStreamChunks, setTtsStreamChunks] = useState<number>(0);
  const [ttsStreamBytes, setTtsStreamBytes] = useState<number>(0);
  const [ttsStreamFrames, setTtsStreamFrames] = useState<number>(0);
  const [ttsOutSampleRate, setTtsOutSampleRate] = useState<number>(0);
  const [ttsStreamMinBufferedMs, setTtsStreamMinBufferedMs] = useState<number>(0);
  const [ttsStreamMaxBufferedMs, setTtsStreamMaxBufferedMs] = useState<number>(0);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string>("default");

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmRef = useRef<Int16Array[]>([]);

  const sampleRate = 16000;

  // ===== Streaming TTS player (WebAudio scheduling) =====
  const ttsCtxRef = useRef<AudioContext | null>(null);
  const ttsSampleRateRef = useRef<number>(24000);
  const ttsStartedRef = useRef<boolean>(false);
  const ttsByteRemainderRef = useRef<Uint8Array>(new Uint8Array(0));
  const ttsPrebufferMs = 650; // scheduling prebuffer; balances latency vs smoothness

  // Scheduled playback state.
  const ttsNextPlayTimeRef = useRef<number>(0);
  const ttsSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  // Coalesce small incoming PCM chunks into larger scheduled buffers to reduce scheduling overhead.
  const ttsPendingChunksRef = useRef<Float32Array[]>([]);
  const ttsPendingFramesRef = useRef<number>(0);
  const ttsScheduleChunkMs = 250; // target size for each scheduled AudioBuffer

  const ttsBufferedMsRef = useRef<number>(0); // updated by interval for UI + min/max
  const ttsMinBufferedMsRef = useRef<number>(Number.POSITIVE_INFINITY);
  const ttsMaxBufferedMsRef = useRef<number>(0);
  const ttsStreamStatusRef = useRef<string>("idle");

  const _ttsOutRate = () => ttsCtxRef.current?.sampleRate ?? ttsSampleRateRef.current;

  const stopTtsStream = (opts?: { resetStats?: boolean }) => {
    const resetStats = opts?.resetStats ?? true;
    ttsStartedRef.current = false;
    ttsByteRemainderRef.current = new Uint8Array(0);
    ttsBufferedMsRef.current = 0;
    ttsNextPlayTimeRef.current = 0;
    ttsPendingChunksRef.current = [];
    ttsPendingFramesRef.current = 0;
    // Stop any scheduled sources.
    for (const s of ttsSourcesRef.current) {
      try {
        s.stop(0);
      } catch {}
      try {
        s.disconnect();
      } catch {}
    }
    ttsSourcesRef.current = [];
    setTtsStreamBufferedMs(0);
    if (resetStats) {
      ttsMinBufferedMsRef.current = Number.POSITIVE_INFINITY;
      ttsMaxBufferedMsRef.current = 0;
      setTtsStreamMinBufferedMs(0);
      setTtsStreamMaxBufferedMs(0);
    }
    setTtsStreamStatus("idle");
  };

  const flushPendingTts = (ctx: AudioContext, inRate: number) => {
    const total = ttsPendingFramesRef.current;
    if (!total) return;
    const chunks = ttsPendingChunksRef.current;
    ttsPendingChunksRef.current = [];
    ttsPendingFramesRef.current = 0;

    const f32 = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      f32.set(c, off);
      off += c.length;
    }

    if (!ttsStartedRef.current) {
      ttsStartedRef.current = true;
      const base = ctx.currentTime + ttsPrebufferMs / 1000;
      ttsNextPlayTimeRef.current = Math.max(ttsNextPlayTimeRef.current || 0, base);
      setTtsStreamStatus("playing");
    }

    const buf = ctx.createBuffer(1, f32.length, inRate);
    buf.copyToChannel(f32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    const startAt = Math.max(ttsNextPlayTimeRef.current, ctx.currentTime);
    src.start(startAt);
    ttsNextPlayTimeRef.current = startAt + buf.duration;

    ttsSourcesRef.current.push(src);
    src.onended = () => {
      const arr = ttsSourcesRef.current;
      const idx = arr.indexOf(src);
      if (idx >= 0) arr.splice(idx, 1);
    };

    // For stats, count *scheduled output frames* (approx).
    const outFrames = Math.max(1, Math.round((f32.length * ctx.sampleRate) / inRate));
    setTtsStreamFrames((n) => n + outFrames);
  };

  useEffect(() => {
    ttsStreamStatusRef.current = ttsStreamStatus;
  }, [ttsStreamStatus]);

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
      const ms =
        ctx && ttsStartedRef.current
          ? Math.max(0, (ttsNextPlayTimeRef.current - ctx.currentTime) * 1000)
          : 0;
      ttsBufferedMsRef.current = ms;
      setTtsStreamBufferedMs(ms);
      if (ttsStreamStatusRef.current !== "idle") {
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
        const msg = JSON.parse(evt.data) as WsMsg;
        if (msg.type === "transcript") setTranscript(msg.text);
        if (msg.type === "tts_begin") {
          stopTtsStream({ resetStats: true });
          ttsSampleRateRef.current = msg.sample_rate;
          setTtsStreamStatus("buffering");
          setTtsStreamChunks(0);
          setTtsStreamBytes(0);
          setTtsStreamFrames(0);
          ttsMinBufferedMsRef.current = Number.POSITIVE_INFINITY;
          ttsMaxBufferedMsRef.current = 0;
          setTtsStreamMinBufferedMs(0);
          setTtsStreamMaxBufferedMs(0);
          ttsNextPlayTimeRef.current = 0;
          // Ensure AudioContext exists (even if suspended).
          void ensureTtsContext(ttsSampleRateRef.current);
        }
        if (msg.type === "tts_chunk") {
          try {
            // Ensure WebAudio has been created/resumed from a user gesture.
            // If not, we still buffer, but playback may be blocked by autoplay policy.
            const bytes = base64ToBytes(msg.audio_b64);
            setTtsStreamBytes((n) => n + bytes.length);

            // Handle odd chunk boundaries: stitch bytes so we always form int16 frames.
            const rem = ttsByteRemainderRef.current;
            let combined: Uint8Array;
            if (rem.length) {
              combined = new Uint8Array(rem.length + bytes.length);
              combined.set(rem, 0);
              combined.set(bytes, rem.length);
            } else {
              combined = bytes;
            }

            const evenLen = combined.length - (combined.length % 2);
            if (evenLen > 0) {
              const frameBytes = combined.subarray(0, evenLen);
              const i16 = bytesToInt16(frameBytes); // PCM @ ttsSampleRateRef
              if (i16.length) {
                const inRate = ttsSampleRateRef.current;
                const f32 = new Float32Array(i16.length);
                for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;

                // Coalesce into bigger buffers before scheduling to reduce main-thread overhead.
                ttsPendingChunksRef.current.push(f32);
                ttsPendingFramesRef.current += f32.length;

                const targetFrames = Math.max(1, Math.floor((inRate * ttsScheduleChunkMs) / 1000));
                if (ttsPendingFramesRef.current >= targetFrames) {
                  void ensureTtsContext(inRate).then((ctx) => flushPendingTts(ctx, inRate));
                }
              }
            }
            ttsByteRemainderRef.current = combined.subarray(evenLen);
            setTtsStreamChunks((n) => n + 1);
          } catch (e: any) {
            setError(e?.message || "Failed to decode TTS chunk");
          }
        }
        if (msg.type === "tts_end") {
          // Drain: keep playing until queue is empty; then stop the processor.
          setTtsStreamStatus("draining");
          // Flush any remaining coalesced audio.
          void ensureTtsContext(ttsSampleRateRef.current).then((ctx) =>
            flushPendingTts(ctx, ttsSampleRateRef.current)
          );
          const check = setInterval(() => {
            const ctx = ttsCtxRef.current;
            const ms =
              ctx && ttsStartedRef.current
                ? Math.max(0, (ttsNextPlayTimeRef.current - ctx.currentTime) * 1000)
                : 0;
            if (ttsStartedRef.current && ms <= 5) {
              // Auto-finish: keep min/max visible for debugging; only clear on next tts_begin or manual stop.
              stopTtsStream({ resetStats: false });
              clearInterval(check);
            }
          }, 200);
        }
        if (msg.type === "tts_audio") {
          (async () => {
            try {
              const blob = await base64ToBlob(msg.audio_b64, "audio/wav");
              const url = URL.createObjectURL(blob);
              setAudioUrl(url);
              setTimeout(() => audioRef.current?.play().catch(() => {}), 0);
            } catch (e: any) {
              setError(e?.message || "Failed to decode/play TTS audio");
            }
          })();
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
      ttsCtxRef.current?.close();
    };
  }, []);

  // Revoke old blob URLs to avoid leaks (but don't tear down the WS connection).
  const prevAudioUrlRef = useRef<string>("");
  useEffect(() => {
    const prev = prevAudioUrlRef.current;
    if (prev && prev !== audioUrl) URL.revokeObjectURL(prev);
    prevAudioUrlRef.current = audioUrl;
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const sendText = () => {
    setError("");
    if (!connected || !wsRef.current) {
      setError("Connect to WS server first.");
      return;
    }
    wsRef.current.send(JSON.stringify({ type: "text", text: textToSend }));
  };

  const speakStream = () => {
    setError("");
    if (!connected || !wsRef.current) {
      setError("Connect to WS server first.");
      return;
    }
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
              <div className="text-xs text-zinc-500">
                (Fallback player for non-streaming WAV responses)
              </div>
              <audio ref={audioRef} src={audioUrl || undefined} controls className="w-full" />
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
