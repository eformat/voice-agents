"""An example showing how to use vLLM to serve multimodal models and run online inference with OpenAI client."""
import argparse
import base64
import os
import threading
import time
from collections import deque
from io import BytesIO

import numpy as np
import soundfile as sf
from openai import OpenAI

OPENAI_AUDIO_SAMPLE_RATE = 24000
DEFAULT_SYSTEM_PROMPT = (
    "Generate audio following instruction.\n\n"
    "<|scene_desc_start|>\n"
    "Audio is recorded from a quiet room.\n"
    "<|scene_desc_end|>"
)


def encode_base64_content_from_file(file_path: str) -> str:
    """Encode a content from a local file to base64 format."""
    # Read the MP3 file as binary and encode it directly to Base64
    with open(file_path, "rb") as audio_file:
        audio_base64 = base64.b64encode(audio_file.read()).decode("utf-8")
    return audio_base64


def _play_audio_array(audio_data: np.ndarray, sample_rate: int) -> None:
    """Play int16 PCM audio (mono or stereo)."""
    # Prefer sounddevice (best UX), fallback to simpleaudio.
    try:
        import sounddevice as sd  # type: ignore

        sd.play(audio_data, samplerate=sample_rate)
        sd.wait()
        return
    except Exception:
        pass

    try:
        import simpleaudio as sa  # type: ignore

        if audio_data.dtype != np.int16:
            audio_data = audio_data.astype(np.int16)
        num_channels = 1 if audio_data.ndim == 1 else int(audio_data.shape[1])
        sa.play_buffer(
            audio_data.tobytes(),
            num_channels=num_channels,
            bytes_per_sample=2,
            sample_rate=sample_rate,
        ).wait_done()
        return
    except Exception as exc:
        raise RuntimeError(
            "Audio playback requires `sounddevice` (recommended) or `simpleaudio`."
        ) from exc


def _play_wav_bytes(wav_bytes: bytes) -> None:
    """Decode WAV bytes and play them."""
    audio_data, sr = sf.read(BytesIO(wav_bytes), dtype="int16", always_2d=False)
    _play_audio_array(audio_data, int(sr))


class _PCMStreamPlayer:
    """Low-latency PCM player for streamed int16 mono audio using sounddevice."""

    def __init__(
        self,
        sample_rate: int,
        channels: int = 1,
        *,
        blocksize: int = 1024,
        latency: str = "high",
    ):
        self.sample_rate = int(sample_rate)
        self.channels = int(channels)
        self.blocksize = int(blocksize)
        self.latency = latency
        self._lock = threading.Lock()
        self._chunks: deque[np.ndarray] = deque()
        self._chunk_offset = 0
        self._closed = False
        self._last_sample = np.int16(0)

        try:
            import sounddevice as sd  # type: ignore

            self._sd = sd
        except Exception as exc:
            raise RuntimeError(
                "Streaming playback requires `sounddevice` (pip install sounddevice)."
            ) from exc

        self._stream = self._sd.OutputStream(
            samplerate=self.sample_rate,
            channels=self.channels,
            dtype="int16",
            blocksize=self.blocksize,
            latency=self.latency,
            callback=self._callback,
        )

    def start(self) -> None:
        self._stream.start()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._chunks.clear()
            self._chunk_offset = 0
        try:
            self._stream.stop()
        finally:
            self._stream.close()

    def push(self, pcm_i16: np.ndarray) -> None:
        """Enqueue mono int16 PCM frames."""
        if pcm_i16 is None:
            return
        arr = np.asarray(pcm_i16)
        if arr.size == 0:
            return
        if arr.dtype != np.int16:
            arr = arr.astype(np.int16, copy=False)
        if arr.ndim != 1:
            # Keep it simple: flatten (treat interleaved as mono).
            arr = arr.reshape(-1)
        with self._lock:
            if self._closed:
                return
            self._chunks.append(arr)

    def buffered_frames(self) -> int:
        """Best-effort count of queued frames (mono)."""
        with self._lock:
            total = 0
            if self._chunks:
                total -= self._chunk_offset
            for c in self._chunks:
                total += int(c.shape[0])
            return max(0, total)

    def buffered_ms(self) -> float:
        return (self.buffered_frames() / float(self.sample_rate)) * 1000.0

    def is_empty(self) -> bool:
        with self._lock:
            return not self._chunks

    def _pop_frames(self, n: int) -> tuple[np.ndarray, int]:
        out = np.zeros((n,), dtype=np.int16)
        filled = 0
        with self._lock:
            while filled < n and self._chunks:
                cur = self._chunks[0]
                avail = cur.shape[0] - self._chunk_offset
                if avail <= 0:
                    self._chunks.popleft()
                    self._chunk_offset = 0
                    continue
                take = min(n - filled, avail)
                out[filled : filled + take] = cur[
                    self._chunk_offset : self._chunk_offset + take
                ]
                self._chunk_offset += take
                filled += take
                if self._chunk_offset >= cur.shape[0]:
                    self._chunks.popleft()
                    self._chunk_offset = 0
        return out, filled

    def _callback(self, outdata, frames, time_info, status):  # noqa: ANN001
        if status:
            # Dropouts/underflows are expected if generation is slower than realtime.
            pass
        mono, filled = self._pop_frames(int(frames))
        if filled < int(frames):
            # Underflow: fade from last sample to 0 to reduce clicking.
            start = filled
            n = int(frames) - filled
            if n > 0:
                fade = np.linspace(
                    float(self._last_sample),
                    0.0,
                    num=n,
                    endpoint=False,
                    dtype=np.float32,
                )
                mono[start:] = np.clip(fade, -32768, 32767).astype(np.int16)
            self._last_sample = np.int16(0)
        else:
            self._last_sample = mono[-1]
        if self.channels == 1:
            outdata[:, 0] = mono
        else:
            for ch in range(self.channels):
                outdata[:, ch] = mono


def run_smart_voice() -> None:
    """Run the smart voice task."""
    chat_completion = client.chat.completions.create(
        messages=[
            {"role": "system", "content": DEFAULT_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "The sun rises in the east and sets in the west. This simple fact has been observed by humans for thousands of years."
                ),
            },
        ],
        model=model,
        modalities=["text", "audio"],
        temperature=1.0,
        top_p=0.95,
        extra_body={"top_k": 50},
        stop=["<|eot_id|>", "<|end_of_text|>", "<|audio_eos|>"],
    )

    text = chat_completion.choices[0].message.content
    audio = chat_completion.choices[0].message.audio.data
    # Decode base64 audio string to bytes
    audio_bytes = base64.b64decode(audio)
    print("Chat completion text output:", text)
    print("Saving the audio to file")
    with open("output_smart_voice.wav", "wb") as f:
        f.write(audio_bytes)


def run_voice_clone() -> None:
    """Run the voice clone task.

    - If --play-stream is set: stream audio + play immediately (no file output)
    - Otherwise: non-streaming request + save wav output
    """
    data_dir = os.path.dirname(__file__)
    audio_path = os.path.join(data_dir, "belinda.wav")
    audio_text_path = os.path.join(data_dir, "belinda.txt")
    with open(audio_text_path) as f:
        audio_text = f.read()
    audio_base64 = encode_base64_content_from_file(audio_path)
    messages = [
        {"role": "user", "content": audio_text},
        {
            "role": "assistant",
            "content": [
                {
                    "type": "input_audio",
                    "input_audio": {
                        "data": audio_base64,
                        "format": "wav",
                    },
                }
            ],
        },
        {
            "role": "user",
            "content": (
                "Hey there! I'm your friendly voice twin in the making. Pick a voice preset below or upload your own audio - let's clone some vocals and bring your voice to life!"
            ),
        },
    ]
    start_time = time.time()
    streaming = bool(args.play_stream)
    chat_completion = client.chat.completions.create(
        messages=messages,
        model=model,
        max_completion_tokens=500,
        stream=streaming,
        modalities=["text", "audio"],
        temperature=1.0,
        top_p=0.95,
        extra_body={"top_k": 50, "audio_chunk_size": args.audio_chunk_size},
        stop=["<|eot_id|>", "<|end_of_text|>", "<|audio_eos|>"],
    )
    if streaming:
        audio_bytes_io = BytesIO()
        i = 0
        first_audio_latency = None
        player: _PCMStreamPlayer | None = None
        started = False
        prebuffer_frames = int(
            (args.prebuffer_ms / 1000.0) * float(OPENAI_AUDIO_SAMPLE_RATE)
        )
        if args.play_stream:
            print(
                f"Starting streaming playback (prebuffer={args.prebuffer_ms}ms, "
                f"blocksize={args.blocksize}, latency={args.latency}, "
                f"audio_chunk_size={args.audio_chunk_size})…"
            )
            player = _PCMStreamPlayer(
                sample_rate=OPENAI_AUDIO_SAMPLE_RATE,
                channels=1,
                blocksize=args.blocksize,
                latency=args.latency,
            )
        for chunk in chat_completion:
            if (
                chunk.choices
                and hasattr(chunk.choices[0].delta, "audio")
                and chunk.choices[0].delta.audio
            ):
                if first_audio_latency is None:
                    first_audio_latency = time.time() - start_time
                audio_bytes = base64.b64decode(chunk.choices[0].delta.audio["data"])
                if not args.play_stream:
                    audio_bytes_io.write(audio_bytes)
                audio_data = np.frombuffer(audio_bytes, dtype=np.int16)
                if player is not None:
                    player.push(audio_data)
                    if not started and player.buffered_frames() >= prebuffer_frames:
                        player.start()
                        started = True
                i += 1
        print(f"First audio latency: {first_audio_latency * 1000} ms")
        print(f"Total audio latency: {(time.time() - start_time) * 1000} ms")
        if args.play_stream:
            assert player is not None
            if not started:
                # If stream ended quickly, still try to play whatever we got.
                player.start()
            # Let remaining queued audio drain.
            drain_start = time.time()
            while not player.is_empty() and (time.time() - drain_start) < 10:
                time.sleep(0.05)
            player.close()
        else:
            audio_bytes_io.seek(0)
            audio_data = np.frombuffer(audio_bytes_io.getvalue(), dtype=np.int16)
            print("Saving the audio to file")
            sf.write("output_voice_clone.wav", audio_data, OPENAI_AUDIO_SAMPLE_RATE)
    else:
        text = chat_completion.choices[0].message.content
        audio = chat_completion.choices[0].message.audio.data
        audio_bytes = base64.b64decode(audio)
        print("Chat completion text output:", text)
        print("Saving the audio to file")
        with open("output_voice_clone.wav", "wb") as f:
            f.write(audio_bytes)


def main(args) -> None:
    """Main function to run the tasks."""
    if args.task == "voice_clone":
        run_voice_clone()
    elif args.task == "smart_voice":
        run_smart_voice()
    else:
        raise ValueError(f"Task {args.task} not supported")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--api-base",
        type=str,
        default="http://localhost:8000/v1",
        help="API base URL for OpenAI client.",
    )
    parser.add_argument(
        "--api-key", type=str, default="fake", help="API key for OpenAI client."
    )
    parser.add_argument(
        "--play-stream",
        action="store_true",
        help="Stream audio and start playing as soon as the first audio chunk arrives (sounddevice required).",
    )
    parser.add_argument(
        "--prebuffer-ms",
        type=int,
        default=2000,
        help="In --play-stream mode, buffer this many milliseconds before starting playback (reduces jitter).",
    )
    parser.add_argument(
        "--blocksize",
        type=int,
        default=1024,
        help="In --play-stream mode, sounddevice blocksize (e.g. 512/1024/2048). Larger is smoother but adds latency.",
    )
    parser.add_argument(
        "--latency",
        type=str,
        default="low",
        help="In --play-stream mode, sounddevice latency setting (e.g. low, high).",
    )
    parser.add_argument(
        "--audio-chunk-size",
        type=int,
        default=20,
        help="Request larger server audio chunks (less jitter, more latency).",
    )
    parser.add_argument(
        "--task",
        type=str,
        default="voice_clone",
        help="Task to run.",
        choices=["voice_clone", "smart_voice"],
    )
    parser.add_argument("--model", type=str, default=None, help="Model to use.")
    args = parser.parse_args()

    client = OpenAI(
        api_key=args.api_key,
        base_url=args.api_base,
    )

    if args.model is None:
        models = client.models.list()
        model = models.data[0].id
    else:
        model = args.model

    main(args)
