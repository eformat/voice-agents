/* eslint-disable @next/next/no-sync-scripts */
"use client";

import { useEffect, useRef, useState } from "react";

type WsMsg =
  | { type: "transcript"; text: string }
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

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmRef = useRef<Int16Array[]>([]);

  const sampleRate = 16000;

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
    setTranscript("");
    setPizzaType("");
    setMessages([]);
    pcmRef.current = [];

    if (!connected || !wsRef.current) {
      setError("Connect to WS server first.");
      return;
    }

    setStatus("requesting mic…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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

  const sendWavFile = async (file: File) => {
    setError("");
    if (!connected || !wsRef.current) {
      setError("Connect to WS server first.");
      return;
    }
    const b64 = await blobToBase64(file);
    wsRef.current.send(JSON.stringify({ type: "audio_wav_b64", audio_b64: b64 }));
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
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

          <div className="text-sm text-zinc-400">
            Status: <span className="text-zinc-200">{status}</span> | Connected:{" "}
            <span className="text-zinc-200">{String(connected)}</span>
          </div>

          {error ? (
            <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <div className="pt-2">
            <label className="text-sm text-zinc-400">Playback</label>
            <audio ref={audioRef} src={audioUrl || undefined} controls className="w-full mt-2" />
          </div>
        </section>

        <section className="rounded-xl border border-zinc-800 p-5 space-y-4">
          <h2 className="font-semibold">Quick Test (No Mic Needed)</h2>
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
        </section>

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
    </div>
  );
}
