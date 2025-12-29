#!/usr/bin/env python3
"""Measure TTS streaming generation speed ("gen x") against an OpenAI-compatible endpoint.

gen_x := (audio_seconds_produced) / (wall_clock_seconds_elapsed)

It uses the same streaming pattern as src/tools.py (chat.completions stream with modalities=["text","audio"]).

Env vars (defaults match src/tools.py):
  - TTS_URL: OpenAI-compatible base URL (e.g. https://.../v1)
  - TTS_MODEL: model name
  - TTS_API_KEY: API key (or API_KEY)
  - TTS_SAMPLE_RATE: expected PCM sample rate (default 24000)
  - TTS_AUDIO_CHUNK_SIZE: provider chunk size hint (default 5)
  - TTS_VOICE: if in {"belinda","clone","voice_clone"}, use belinda.wav/belinda.txt conditioning
  - TTS_VOICE_WAV / TTS_VOICE_TXT: optional override paths for conditioning files

Usage:
  ./venv/bin/python test-genx.py
  TTS_URL=... TTS_MODEL=... TTS_API_KEY=... ./venv/bin/python test-genx.py
"""

from __future__ import annotations

import argparse
import base64
import os
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

PROMPT_DEFAULT = (
    "We have several delicious pizza options available. What type of pizza would you like to order? "
    "You can choose from Margherita, Pepperoni, Vegetarian, Hawaiian, Meat Lovers, BBQ Chicken, "
    "or Spinach and Mushroom. Which one sounds good to you?"
)


def _encode_b64_file(p: Path) -> str:
    """Encode a file to base64."""
    return base64.b64encode(p.read_bytes()).decode("utf-8")


def _build_messages(text: str) -> list[dict]:
    """Build messages for the TTS model."""
    tts_voice = (os.getenv("TTS_VOICE", "") or "").strip().lower()
    use_voice_clone = tts_voice in {"belinda", "clone", "voice_clone"}

    if use_voice_clone:
        voice_wav = (
            Path(os.getenv("TTS_VOICE_WAV", ""))
            if os.getenv("TTS_VOICE_WAV")
            else Path(__file__).resolve().parent / "belinda.wav"
        )
        voice_txt = (
            Path(os.getenv("TTS_VOICE_TXT", ""))
            if os.getenv("TTS_VOICE_TXT")
            else Path(__file__).resolve().parent / "belinda.txt"
        )
        if not voice_wav.exists() or not voice_txt.exists():
            raise RuntimeError(
                f"Voice clone requested (TTS_VOICE={tts_voice!r}) but files missing: {voice_wav} / {voice_txt}"
            )
        audio_text = voice_txt.read_text(encoding="utf-8", errors="replace")
        audio_b64 = _encode_b64_file(voice_wav)
        return [
            {"role": "user", "content": audio_text},
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {"data": audio_b64, "format": "wav"},
                    }
                ],
            },
            {"role": "user", "content": text},
        ]

    system_prompt = (
        "Generate audio following instruction.\n\n"
        "<|scene_desc_start|>\n"
        "Audio is recorded from a quiet room.\n"
        "<|scene_desc_end|>"
    )
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": text},
    ]


def main() -> int:
    """Main function."""
    ap = argparse.ArgumentParser(description="Measure TTS streaming gen x.")
    ap.add_argument("--text", default=PROMPT_DEFAULT, help="Text to synthesize.")
    args = ap.parse_args()

    tts_url = os.getenv("TTS_URL", "")
    tts_model = os.getenv("TTS_MODEL", "")
    tts_api_key = os.getenv("TTS_API_KEY", os.getenv("API_KEY", ""))
    sample_rate = int(os.getenv("TTS_SAMPLE_RATE", "24000"))
    audio_chunk_size = int(os.getenv("TTS_AUDIO_CHUNK_SIZE", "5"))
    timeout_s = float(os.getenv("TTS_TIMEOUT_S", "30"))

    if not tts_url or not tts_model:
        raise SystemExit("Missing TTS_URL and/or TTS_MODEL env vars.")

    try:
        from openai import OpenAI
    except Exception as exc:
        raise SystemExit(
            "Missing dependency: openai. Install with `pip install openai`."
        ) from exc

    client = OpenAI(
        api_key=tts_api_key or "fake",
        base_url=tts_url,
        timeout=timeout_s,
        max_retries=1,
    )

    messages = _build_messages(args.text)

    t0 = time.perf_counter()
    first_chunk_t = None
    total_bytes = 0

    chat_completion = client.chat.completions.create(
        messages=messages,
        model=tts_model,
        stream=True,
        modalities=["text", "audio"],
        temperature=1.0,
        top_p=0.95,
        extra_body={"top_k": 50, "audio_chunk_size": audio_chunk_size},
        stop=["<|eot_id|>", "<|end_of_text|>", "<|audio_eos|>"],
    )

    for chunk in chat_completion:
        if (
            chunk.choices
            and hasattr(chunk.choices[0].delta, "audio")
            and chunk.choices[0].delta.audio
        ):
            audio_b64 = chunk.choices[0].delta.audio.get("data")
            if audio_b64:
                if first_chunk_t is None:
                    first_chunk_t = time.perf_counter()
                pcm = base64.b64decode(audio_b64)
                total_bytes += len(pcm)

    t1 = time.perf_counter()

    # mono int16 PCM
    total_samples = total_bytes // 2
    audio_seconds = total_samples / float(sample_rate)
    elapsed = max(1e-9, t1 - t0)
    gen_x = audio_seconds / elapsed
    ttft_ms = (first_chunk_t - t0) * 1000 if first_chunk_t is not None else None

    print("=== gen x measurement ===")
    print(f"model: {tts_model}")
    print(f"sample_rate: {sample_rate} Hz")
    print(f"audio_chunk_size: {audio_chunk_size}")
    if ttft_ms is None:
        print("ttft: (no audio chunks)")
    else:
        print(f"ttft: {ttft_ms:.0f} ms")
    print(f"total_bytes: {total_bytes}")
    print(f"audio_seconds: {audio_seconds:.3f} s")
    print(f"wall_seconds: {elapsed:.3f} s")
    print(f"gen_x: {gen_x:.3f}x")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
