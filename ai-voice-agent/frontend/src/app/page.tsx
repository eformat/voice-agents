/* eslint-disable @next/next/no-sync-scripts */
"use client";

import { useEffect, useRef, useState } from "react";

type WsMsg =
  | { type: "transcript"; text: string }
  | { type: "tts_begin"; format: "pcm_s16le"; sample_rate: number }
  | { type: "tts_first_token" }
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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
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

function bytesToInt16View(bytes: Uint8Array): Int16Array {
  if (bytes.byteLength % 2 === 0 && bytes.byteOffset % 2 === 0) {
    return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  }
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Int16Array(buf);
}

// ─── Talking Pizza SVG ─────────────────────────────────────────────────────────
function TalkingPizza({ isTalking, className }: { isTalking: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 400 400" className={className} xmlns="http://www.w3.org/2000/svg">
      <g className={isTalking ? "pizza-talking" : ""} style={{ transformOrigin: "200px 200px" }}>
        <path d="M 80 280 Q 200 60 320 280 Z" fill="#F5C342" stroke="#D4A017" strokeWidth="4" />
        <path d="M 80 280 Q 200 240 320 280" fill="#D4A017" stroke="#B8860B" strokeWidth="3" />
        <path d="M 110 265 Q 200 90 290 265 Z" fill="#CC3333" opacity="0.7" />
        <circle cx="170" cy="200" r="18" fill="#FFE4A0" opacity="0.6" />
        <circle cx="230" cy="190" r="15" fill="#FFE4A0" opacity="0.5" />
        <circle cx="200" cy="150" r="12" fill="#FFE4A0" opacity="0.6" />
        <circle cx="155" cy="215" r="14" fill="#CC2200" />
        <circle cx="245" cy="210" r="12" fill="#CC2200" />
        <circle cx="200" cy="160" r="11" fill="#CC2200" />
        <circle cx="180" cy="175" r="10" fill="#CC2200" />
        <circle cx="225" cy="170" r="9" fill="#CC2200" />
        <g>
          <ellipse cx="170" cy="155" rx="16" ry="18" fill="white" />
          <ellipse cx="173" cy="157" rx="8" ry="10" fill="#222" />
          <circle cx="176" cy="153" r="3" fill="white" />
          <ellipse cx="230" cy="155" rx="16" ry="18" fill="white" />
          <ellipse cx="233" cy="157" rx="8" ry="10" fill="#222" />
          <circle cx="236" cy="153" r="3" fill="white" />
        </g>
        {isTalking ? (
          <g>
            <ellipse cx="200" cy="230" rx="30" ry="18" fill="#8B0000" />
            <ellipse cx="200" cy="225" rx="30" ry="6" fill="none" stroke="#222" strokeWidth="2" />
            <ellipse cx="200" cy="238" rx="12" ry="5" fill="#FF6B6B" />
          </g>
        ) : (
          <g>
            <path d="M 170 225 Q 200 245 230 225" fill="none" stroke="#222" strokeWidth="3" strokeLinecap="round" />
          </g>
        )}
        <g>
          <ellipse cx="200" cy="108" rx="60" ry="10" fill="#CC0000" />
          <rect x="155" y="75" width="90" height="35" rx="6" fill="#EE0000" />
          <rect x="145" y="100" width="110" height="14" rx="4" fill="#CC0000" />
          <rect x="160" y="80" width="40" height="4" rx="2" fill="#FF4444" opacity="0.5" />
        </g>
      </g>
    </svg>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────
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
  const [ttsStreamChunks, setTtsStreamChunks] = useState<number>(0);
  const [ttsStreamBytes, setTtsStreamBytes] = useState<number>(0);
  const [ttsOutSampleRate, setTtsOutSampleRate] = useState<number>(0);
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
  const [controlsOpen, setControlsOpen] = useState(false);
  const [waiting, setWaiting] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const ttsReceivingBinaryRef = useRef<boolean>(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmRef = useRef<Int16Array[]>([]);

  const sampleRate = 16000;

  // ===== Streaming TTS: scheduled AudioBufferSourceNode playback =====
  const ttsCtxRef = useRef<AudioContext | null>(null);
  const ttsSampleRateRef = useRef<number>(24000);
  const ttsNextPlayTimeRef = useRef<number>(0);
  const ttsScheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const ttsPrebufferChunksRef = useRef<ArrayBuffer[]>([]);
  const ttsPrebufferSamplesRef = useRef<number>(0);
  const ttsPrebufferingRef = useRef<boolean>(true);
  const ttsPrebufferMs = 300;

  const ttsReqStartedAtMsRef = useRef<number>(0);
  const ttsFirstTokenAtMsRef = useRef<number>(0);
  const ttsFirstAudioAtMsRef = useRef<number>(0);
  const ttsStreamBytesRef = useRef<number>(0);
  const ttsStreamChunksRef = useRef<number>(0);
  const ttsRxStartedAtMsRef = useRef<number>(0);
  const ttsRxLastAtMsRef = useRef<number>(0);
  const ttsRxInSamplesRef = useRef<number>(0);
  const [ttsGenRealtimeX, setTtsGenRealtimeX] = useState<number>(0);

  // Recording (capture original PCM from model).
  const ttsRecordedBuffersRef = useRef<ArrayBuffer[]>([]);
  const ttsRecordedBytesLenRef = useRef<number>(0);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const ttsStreamStatusRef = useRef<string>("idle");

  const isSpeaking = ttsStreamStatus === "buffering" || ttsStreamStatus === "playing" || ttsStreamStatus === "draining";

  // Auto-scroll conversation
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, waiting]);

  // ─── TTS Playback (AudioBufferSourceNode scheduling) ──────────────
  const ensureTtsContext = async (): Promise<AudioContext> => {
    if (ttsCtxRef.current && ttsCtxRef.current.state !== "closed") {
      if (ttsCtxRef.current.state === "suspended") {
        await ttsCtxRef.current.resume();
      }
      return ttsCtxRef.current;
    }
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    ttsCtxRef.current = ctx;
    setTtsOutSampleRate(ctx.sampleRate);
    return ctx;
  };

  const schedulePcmChunk = (ctx: AudioContext, pcmBuf: ArrayBuffer, inRate: number) => {
    const int16 = new Int16Array(pcmBuf);
    if (int16.length === 0) return;
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    const buffer = ctx.createBuffer(1, float32.length, inRate);
    buffer.getChannelData(0).set(float32);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    if (ttsNextPlayTimeRef.current < now) {
      ttsNextPlayTimeRef.current = now;
    }
    source.start(ttsNextPlayTimeRef.current);
    ttsScheduledSourcesRef.current.push(source);
    ttsNextPlayTimeRef.current += buffer.duration;
  };

  const flushPrebuffer = (ctx: AudioContext, inRate: number) => {
    for (const chunk of ttsPrebufferChunksRef.current) {
      schedulePcmChunk(ctx, chunk, inRate);
    }
    ttsPrebufferChunksRef.current = [];
    ttsPrebufferSamplesRef.current = 0;
    ttsPrebufferingRef.current = false;
    setTtsStreamStatus("playing");
  };

  const stopTtsStream = (opts?: { resetStats?: boolean }) => {
    // Stop all scheduled sources
    for (const src of ttsScheduledSourcesRef.current) {
      try { src.stop(); } catch {}
    }
    ttsScheduledSourcesRef.current = [];
    ttsNextPlayTimeRef.current = 0;
    ttsPrebufferChunksRef.current = [];
    ttsPrebufferSamplesRef.current = 0;
    ttsPrebufferingRef.current = true;
    ttsReceivingBinaryRef.current = false;
    setTtsStreamStatus("idle");
    setWaiting(false);
  };

  const clearTtsRecording = () => {
    setTtsRecordedUrl("");
    setTtsRecordedFilename("");
    setTtsRecordedSampleRate(0);
    setTtsRecordedDurationMs(0);
    setTtsRecordedBytes(0);
    ttsRecordedBuffersRef.current = [];
    ttsRecordedBytesLenRef.current = 0;
  };

  const finalizeTtsRecording = () => {
    if (!ttsRecordEnabled) return;
    const sr = ttsRecordedSampleRate || ttsSampleRateRef.current;
    if (!sr) return;
    const bufs = ttsRecordedBuffersRef.current;
    const totalBytes = ttsRecordedBytesLenRef.current;
    if (!bufs.length || !totalBytes) return;
    const joinedBytes = new Uint8Array(totalBytes);
    let offB = 0;
    for (const b of bufs) {
      joinedBytes.set(new Uint8Array(b), offB);
      offB += b.byteLength;
    }
    const evenLen = joinedBytes.length - (joinedBytes.length % 2);
    const i16 = bytesToInt16View(joinedBytes.subarray(0, evenLen));
    const wav = pcmToWavBlob(i16, sr);
    const durationMs = (i16.length / sr) * 1000;
    const url = URL.createObjectURL(wav);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    setTtsRecordedUrl(url);
    setTtsRecordedFilename(`tts-stream-${ts}.wav`);
    setTtsRecordedBytes(wav.size);
    setTtsRecordedDurationMs(durationMs);
  };

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

  // Generation speed stats (updated on interval).
  useEffect(() => {
    const id = window.setInterval(() => {
      setTtsStreamBytes(ttsStreamBytesRef.current);
      setTtsStreamChunks(ttsStreamChunksRef.current);
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
    }, 200);
    return () => window.clearInterval(id);
  }, []);

  // ─── WebSocket ────────────────────────────────────────────────────
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
    ws.onmessage = async (evt) => {
      try {
        // ── Binary frames: TTS audio chunks ──
        if (typeof evt.data !== "string") {
          if (!ttsReceivingBinaryRef.current) return;
          const handleBuffer = async (buf: ArrayBuffer) => {
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
            const inSamples = Math.floor(len / 2);
            ttsRxInSamplesRef.current += inSamples;

            // Recording
            if (ttsRecordEnabled) {
              ttsRecordedBuffersRef.current.push(buf.slice(0));
              ttsRecordedBytesLenRef.current += buf.byteLength;
            }

            // Schedule playback
            const ctx = ttsCtxRef.current;
            if (!ctx) return;
            if (ctx.state === "suspended") await ctx.resume();

            if (ttsPrebufferingRef.current) {
              ttsPrebufferChunksRef.current.push(buf);
              ttsPrebufferSamplesRef.current += inSamples;
              const prebufferSamples = Math.floor(inRate * ttsPrebufferMs / 1000);
              if (ttsPrebufferSamplesRef.current >= prebufferSamples) {
                flushPrebuffer(ctx, inRate);
              }
            } else {
              schedulePcmChunk(ctx, buf, inRate);
            }
          };

          if (evt.data instanceof ArrayBuffer) {
            void handleBuffer(evt.data);
            return;
          }
          if (evt.data instanceof Blob) {
            void evt.data.arrayBuffer().then((buf) => handleBuffer(buf));
            return;
          }
          return;
        }

        // ── JSON messages ──
        const msg = JSON.parse(evt.data) as WsMsg;
        if (msg.type === "transcript") setTranscript(msg.text);

        if (msg.type === "tts_begin") {
          stopTtsStream();
          ttsSampleRateRef.current = msg.sample_rate;
          ttsReceivingBinaryRef.current = true;
          ttsFirstAudioAtMsRef.current = 0;
          ttsFirstTokenAtMsRef.current = 0;
          setTtsTtftMs(0);
          setTtsTtfbMs(0);
          setTtsStreamStatus("buffering");
          ttsStreamChunksRef.current = 0;
          ttsStreamBytesRef.current = 0;
          ttsRxStartedAtMsRef.current = Date.now();
          ttsRxLastAtMsRef.current = ttsRxStartedAtMsRef.current;
          ttsRxInSamplesRef.current = 0;
          setTtsStreamChunks(0);
          setTtsStreamBytes(0);
          setTtsGenRealtimeX(0);
          if (ttsRecordEnabled) {
            clearTtsRecording();
            setTtsRecordedSampleRate(msg.sample_rate);
          }
          // Ensure AudioContext exists and is running.
          await ensureTtsContext();
        }

        if (msg.type === "tts_first_token") {
          if (ttsFirstTokenAtMsRef.current === 0) {
            ttsFirstTokenAtMsRef.current = Date.now();
            if (ttsReqStartedAtMsRef.current > 0) {
              setTtsTtftMs(ttsFirstTokenAtMsRef.current - ttsReqStartedAtMsRef.current);
            }
          }
        }

        if (msg.type === "tts_end") {
          ttsReceivingBinaryRef.current = false;
          if (ttsReqStartedAtMsRef.current > 0 && ttsFirstTokenAtMsRef.current > 0) {
            setTtsTtftMs(ttsFirstTokenAtMsRef.current - ttsReqStartedAtMsRef.current);
          }
          if (ttsReqStartedAtMsRef.current > 0 && ttsFirstAudioAtMsRef.current > 0) {
            setTtsTtfbMs(ttsFirstAudioAtMsRef.current - ttsReqStartedAtMsRef.current);
          }
          // Flush any remaining prebuffer
          const ctx = ttsCtxRef.current;
          const inRate = ttsSampleRateRef.current || 24000;
          if (ctx && ttsPrebufferingRef.current && ttsPrebufferChunksRef.current.length > 0) {
            flushPrebuffer(ctx, inRate);
          }
          setTtsStreamStatus("draining");
          finalizeTtsRecording();
          // Wait for scheduled audio to finish, then clean up.
          const endTime = ttsNextPlayTimeRef.current;
          const check = setInterval(() => {
            const c = ttsCtxRef.current;
            if (!c || c.currentTime >= endTime) {
              stopTtsStream();
              clearInterval(check);
            }
          }, 200);
        }

        if (msg.type === "graph_result") {
          setPizzaType(msg.pizza_type);
          setMessages(msg.messages);
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

  // ─── Microphone recording ────────────────────────────────────────
  const startRecording = async () => {
    setError("");
    setTranscript("");
    pcmRef.current = [];
    if (!connected || !wsRef.current) {
      setError("Connect to WS server first.");
      return;
    }
    setStatus("requesting mic\u2026");
    try {
      const constraints: MediaStreamConstraints =
        micDeviceId && micDeviceId !== "default"
          ? { audio: { deviceId: { exact: micDeviceId } } }
          : { audio: true };
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err: any) {
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
    setWaiting(true);
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

  const sendText = () => {
    setError("");
    if (!connected || !wsRef.current) {
      setError("Connect to WS server first.");
      return;
    }
    ttsReqStartedAtMsRef.current = Date.now();
    ttsFirstTokenAtMsRef.current = 0;
    ttsFirstAudioAtMsRef.current = 0;
    setTtsTtftMs(0);
    setTtsTtfbMs(0);
    // Prime audio context inside user gesture so playback isn't blocked.
    void ensureTtsContext();
    setWaiting(true);
    wsRef.current.send(JSON.stringify({ type: "text", text: textToSend }));
  };

  const speakStream = () => {
    setError("");
    if (!connected || !wsRef.current) {
      setError("Connect to WS server first.");
      return;
    }
    ttsReqStartedAtMsRef.current = Date.now();
    ttsFirstTokenAtMsRef.current = 0;
    ttsFirstAudioAtMsRef.current = 0;
    setTtsTtftMs(0);
    setTtsTtfbMs(0);
    void ensureTtsContext();
    wsRef.current.send(JSON.stringify({ type: "tts_text", text: textToSend }));
  };

  const sendWavFile = async (file: File) => {
    setError("");
    if (!connected || !wsRef.current) {
      setError("Connect to WS server first.");
      return;
    }
    ttsReqStartedAtMsRef.current = Date.now();
    ttsFirstTokenAtMsRef.current = 0;
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
      } catch {}
    };
    void loadDevices();
  }, []);

  // Helper: get the last agent message for the speech bubble
  const lastAgentMessage = [...messages].reverse().find(
    (m) => m.role !== "human" && m.role !== "interrupt" && !m.content.startsWith("Routing to")
  );

  // ─── UI ───────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col overflow-hidden bg-rh-gray-95 text-rh-gray-10">
      {/* ─── Nav Bar ─────────────────────────────────────────────── */}
      <nav className="flex-none h-14 flex items-center px-6 border-b border-rh-gray-80 bg-rh-gray-95">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <div className="w-5 h-1 bg-rh-red rounded-sm" />
            <div className="w-2 h-2 bg-rh-red rounded-sm" />
          </div>
          <h1 className="text-lg font-bold" style={{ fontFamily: "'Red Hat Display', sans-serif" }}>
            Red Hat Pizza Shop
          </h1>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs">
            <div className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-rh-gray-50"}`} />
            <span className="text-rh-gray-40">{connected ? "Connected" : "Disconnected"}</span>
          </div>
          <button
            onClick={() => setControlsOpen(!controlsOpen)}
            className="text-xs px-3 py-1.5 rounded border border-rh-gray-70 text-rh-gray-40 hover:text-white hover:border-rh-gray-50 transition-colors"
          >
            Controls {controlsOpen ? "\u25B2" : "\u25BC"}
          </button>
        </div>
      </nav>

      {/* ─── Controls Panel (collapsible) ────────────────────────── */}
      {controlsOpen && (
        <div className="flex-none border-b border-rh-gray-80 bg-rh-gray-90 px-6 py-4 animate-fade-in-up">
          <div className="max-w-5xl mx-auto grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <label className="text-xs text-rh-gray-40 uppercase tracking-wider font-semibold">WebSocket URL</label>
              <input
                className="w-full rounded bg-rh-gray-95 border border-rh-gray-70 px-3 py-2 text-sm text-white placeholder-rh-gray-50 focus:border-rh-red focus:ring-1 focus:ring-rh-red focus:outline-none"
                value={wsUrl}
                onChange={(e) => setWsUrl(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  className="rounded bg-rh-red text-white px-3 py-1.5 text-xs font-semibold hover:bg-rh-red-dark disabled:opacity-40 transition-colors"
                  onClick={connect}
                  disabled={connected}
                >
                  Connect
                </button>
                <button
                  className="rounded border border-rh-gray-70 text-rh-gray-40 px-3 py-1.5 text-xs hover:text-white disabled:opacity-40 transition-colors"
                  onClick={disconnect}
                  disabled={!connected}
                >
                  Disconnect
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-xs text-rh-gray-40 uppercase tracking-wider font-semibold">Microphone</label>
              <select
                className="w-full rounded bg-rh-gray-95 border border-rh-gray-70 px-3 py-2 text-sm text-white focus:border-rh-red focus:outline-none"
                value={micDeviceId}
                onChange={(e) => setMicDeviceId(e.target.value)}
              >
                <option value="default">Default</option>
                {micDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Mic (${d.deviceId.slice(0, 8)}\u2026)`}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-xs text-rh-gray-40 uppercase tracking-wider font-semibold">Quick Test</label>
              <textarea
                className="w-full min-h-[56px] rounded bg-rh-gray-95 border border-rh-gray-70 px-3 py-2 text-sm text-white placeholder-rh-gray-50 focus:border-rh-red focus:outline-none resize-none"
                value={textToSend}
                onChange={(e) => setTextToSend(e.target.value)}
                rows={2}
              />
              <div className="flex gap-2">
                <button
                  className="rounded bg-rh-red text-white px-3 py-1.5 text-xs font-semibold hover:bg-rh-red-dark disabled:opacity-40 transition-colors"
                  onClick={sendText}
                  disabled={!connected}
                >
                  Send Text
                </button>
                <button
                  className="rounded border border-rh-gray-70 text-rh-gray-40 px-3 py-1.5 text-xs hover:text-white disabled:opacity-40 transition-colors"
                  onClick={speakStream}
                  disabled={!connected}
                >
                  TTS Only
                </button>
                <label className="rounded border border-rh-gray-70 text-rh-gray-40 px-3 py-1.5 text-xs hover:text-white cursor-pointer transition-colors">
                  Upload WAV
                  <input
                    type="file"
                    accept="audio/wav"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void sendWavFile(f);
                    }}
                    disabled={!connected}
                  />
                </label>
              </div>
            </div>
          </div>
          <div className="max-w-5xl mx-auto mt-3 pt-3 border-t border-rh-gray-70">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-rh-gray-40">
              <span>TTS: <span className="text-rh-gray-20">{ttsStreamStatus}</span></span>
              <span>Gen: <span className="text-rh-gray-20">{ttsGenRealtimeX.toFixed(2)}x</span></span>
              <span>TTFT: <span className="text-rh-gray-20">{ttsTtftMs ? `${ttsTtftMs}ms` : "-"}</span></span>
              <span>TTFB: <span className="text-rh-gray-20">{ttsTtfbMs ? `${ttsTtfbMs}ms` : "-"}</span></span>
              <span>Chunks: <span className="text-rh-gray-20">{ttsStreamChunks}</span></span>
              <span>Bytes: <span className="text-rh-gray-20">{ttsStreamBytes}</span></span>
              <span>outHz: <span className="text-rh-gray-20">{ttsOutSampleRate || "-"}</span></span>
              {ttsRecordedUrl && (
                <>
                  <span>Recorded: <span className="text-rh-gray-20">{(ttsRecordedDurationMs / 1000).toFixed(2)}s</span></span>
                  <a href={ttsRecordedUrl} download={ttsRecordedFilename} className="text-rh-red hover:underline">Download WAV</a>
                </>
              )}
              <button onClick={() => stopTtsStream()} className="text-rh-red hover:underline">Stop Playback</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Main Content ────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">

        {/* ─── Left: Pizza + Action Buttons ──────────────────────── */}
        <div className="flex-none lg:w-[420px] flex flex-col items-center justify-center p-6 lg:p-10 gap-6">
          <div className="relative">
            <TalkingPizza
              isTalking={isSpeaking}
              className="w-48 h-48 lg:w-64 lg:h-64 drop-shadow-2xl"
            />
            {isSpeaking && (
              <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="w-1.5 h-1.5 rounded-full bg-rh-red"
                    style={{ animation: `pulse-red 1s ${i * 0.2}s infinite` }}
                  />
                ))}
              </div>
            )}
          </div>
          {lastAgentMessage && (
            <div className="max-w-xs text-center bg-rh-gray-90 border border-rh-gray-70 rounded-2xl px-4 py-3 text-sm text-rh-gray-20 animate-fade-in-up relative">
              <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-4 h-4 bg-rh-gray-90 border-l border-t border-rh-gray-70 rotate-45" />
              <span className="relative">{lastAgentMessage.content}</span>
            </div>
          )}
          <div className="text-xs text-rh-gray-50">
            {status === "recording" ? (
              <span className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-rh-red animate-pulse-red" />
                Recording...
              </span>
            ) : (
              status
            )}
          </div>
          <div className="flex gap-4">
            <button
              className="rounded-xl px-8 py-4 text-lg font-bold transition-all disabled:opacity-30
                bg-rh-green text-white hover:bg-rh-green-dark
                shadow-lg hover:shadow-xl active:scale-95"
              style={{ minWidth: 120 }}
              onClick={() => {
                void ensureTtsContext();
                startRecording();
              }}
              disabled={!connected || status === "recording"}
            >
              TALK
            </button>
            <button
              className="rounded-xl px-8 py-4 text-lg font-bold transition-all disabled:opacity-30
                bg-rh-red text-white hover:bg-rh-red-dark
                shadow-lg hover:shadow-xl active:scale-95"
              style={{ minWidth: 120 }}
              onClick={stopAndSend}
              disabled={!connected || status !== "recording"}
            >
              SEND
            </button>
          </div>
          <div className="w-full max-w-xs flex gap-2">
            <input
              className="flex-1 rounded-lg bg-rh-gray-90 border border-rh-gray-70 px-3 py-2 text-sm text-white placeholder-rh-gray-50 focus:border-rh-red focus:ring-1 focus:ring-rh-red focus:outline-none"
              placeholder="Type a message..."
              value={textToSend}
              onChange={(e) => setTextToSend(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendText();
                }
              }}
            />
            <button
              className="rounded-lg bg-rh-red text-white px-4 py-2 text-sm font-semibold hover:bg-rh-red-dark disabled:opacity-40 transition-colors"
              onClick={sendText}
              disabled={!connected}
            >
              Send
            </button>
          </div>
          {error && (
            <div className="w-full max-w-xs rounded-lg border border-red-900 bg-rh-red-bg/60 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}
        </div>

        {/* ─── Right: Transcript + Conversation ──────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden border-l border-rh-gray-80">
          <div className="flex-none border-b border-rh-gray-80">
            <div className="px-6 py-3 border-b border-rh-gray-80 flex items-center justify-between">
              <h2 className="text-sm font-semibold" style={{ fontFamily: "'Red Hat Display', sans-serif" }}>
                Agent Transcript
              </h2>
              {pizzaType && (
                <span className="text-xs px-2 py-0.5 rounded bg-rh-red/20 text-rh-red border border-rh-red/30">
                  {pizzaType}
                </span>
              )}
            </div>
            <div className="px-6 py-3 max-h-32 overflow-y-auto rh-scroll">
              <p className="text-sm text-rh-gray-20 whitespace-pre-wrap">
                {transcript || "Waiting for speech..."}
              </p>
            </div>
          </div>
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-none px-6 py-3 border-b border-rh-gray-80">
              <h2 className="text-sm font-semibold" style={{ fontFamily: "'Red Hat Display', sans-serif" }}>
                Conversation History
              </h2>
            </div>
            <div className="flex-1 overflow-y-auto rh-scroll px-6 py-4 space-y-3">
              {messages.length ? (
                messages.filter((m) => m.role !== "interrupt").map((m, i) => {
                  const isHuman = m.role === "human";
                  const isRouting = m.content.startsWith("Routing to");
                  if (isRouting) {
                    return (
                      <div key={i} className="flex justify-center">
                        <span className="text-xs text-rh-gray-50 bg-rh-gray-90 px-3 py-1 rounded-full">
                          {m.content}
                        </span>
                      </div>
                    );
                  }
                  return (
                    <div key={i} className={`flex ${isHuman ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                          isHuman
                            ? "bg-rh-red/15 border border-rh-red/20 text-rh-gray-10"
                            : "bg-rh-gray-90 border border-rh-gray-70 text-rh-gray-20"
                        }`}
                      >
                        <div className="text-[10px] uppercase tracking-wider text-rh-gray-50 mb-1 font-semibold">
                          {m.role}
                        </div>
                        <div className="text-sm whitespace-pre-wrap">{m.content}</div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="flex-1 flex items-center justify-center text-rh-gray-50 text-sm">
                  Say something to start a conversation...
                </div>
              )}
              {waiting && (
                <div className="flex justify-start">
                  <div className="bg-rh-gray-90 border border-rh-gray-70 rounded-2xl px-5 py-3 flex items-center gap-2">
                    <svg className="w-4 h-4 animate-spin text-rh-red" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span className="text-sm text-rh-gray-40">Thinking...</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </div>
        </div>
      </div>
      <div className="flex-none h-px bg-gradient-to-r from-rh-red via-rh-red/20 to-transparent" />
    </div>
  );
}
