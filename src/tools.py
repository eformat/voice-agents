"""Domain-specific tools for voice agents.

This module provides specialized tools:
- convert_text_to_speech: For text to speech agent
- convert_speech_to_text: For speech to text agent
- listen_for_user_speech: Capture microphone audio and transcribe it
"""

import base64
import io
import os
import time
import wave
from pathlib import Path
from typing import Iterator

import requests
import simpleaudio as sa
from dotenv import load_dotenv
from langchain.tools import tool

load_dotenv()

TTS_URL = os.getenv("TTS_URL", "TTS_URL")
TTS_MODEL = os.getenv("TTS_MODEL", "TTS_MODEL")
TTS_VOICE = os.getenv("TTS_VOICE", "TTS_VOICE")
PLAY_AUDIO = os.getenv("PLAY_AUDIO", "0").lower() in ("1", "true", "yes", "y")
TTS_SAMPLE_RATE = int(os.getenv("TTS_SAMPLE_RATE", "24000"))
TTS_API_KEY = os.getenv("TTS_API_KEY", os.getenv("API_KEY", ""))
# Higgs streamed audio can arrive in fairly large bursts depending on `audio_chunk_size`.
# A smaller default yields smoother realtime playback in the browser.
TTS_AUDIO_CHUNK_SIZE = int(os.getenv("TTS_AUDIO_CHUNK_SIZE", "5"))
TTS_TIMEOUT_S = float(os.getenv("TTS_TIMEOUT_S", "30"))

STT_URL = os.getenv("STT_URL", "STT_URL")
STT_MODEL = os.getenv("STT_MODEL", "STT_MODEL")
STT_TOKEN = os.getenv("STT_TOKEN", "STT_TOKEN")

SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # bytes (int16)
_LISTENING_PAUSED = False


def pause_listening() -> None:
    """Signal to pause background listening callbacks."""
    global _LISTENING_PAUSED
    _LISTENING_PAUSED = True
    print("Listening paused")


def resume_listening() -> None:
    """Signal to resume background listening callbacks."""
    global _LISTENING_PAUSED
    _LISTENING_PAUSED = False
    print("Listening resumed")


def is_listening_paused() -> bool:
    """Return True if listening is currently paused."""
    return _LISTENING_PAUSED


@tool
def add_to_order(item: str) -> str:
    """Add an item to the customer's order."""
    print("add_to_order tool called with item: ", item)
    return f"Added {item} to the order."


@tool
def convert_text_to_speech(text: str = ""):
    """Convert text to speech and play the generated audio."""
    print("convert_text_to_speech tool called with text: ", text)

    if not text or not text.strip():
        # IMPORTANT: allow tool calls with missing args (LLM sometimes emits {}).
        # Returning a string avoids crashing the graph/tool pipeline.
        return "No text provided for speech synthesis (empty tool call)."

    if not PLAY_AUDIO:
        # In cloud/container environments, audio playback is not possible.
        # We keep the tool callable but do not attempt to play.
        return "Audio playback disabled (PLAY_AUDIO=0)."

    if sa is None:
        return "Audio playback is unavailable because simpleaudio is not installed."

    pause_listening()

    url = TTS_URL
    payload = {
        "model": TTS_MODEL,
        "voice": TTS_VOICE,
        "input": text,
        "response_format": "pcm",
    }

    try:
        response = requests.post(url, json=payload, timeout=60)
        response.raise_for_status()
    except requests.RequestException as exc:
        return f"Failed to generate audio: {exc}"

    pcm_audio = response.content
    if not pcm_audio:
        return "No audio was returned from the service."

    # simpleaudio expects raw PCM; ensure we have complete frames (2 bytes/sample).
    if len(pcm_audio) % 2 != 0:
        pcm_audio += b"\x00"

    try:
        play_obj = sa.play_buffer(
            pcm_audio, num_channels=1, bytes_per_sample=2, sample_rate=TTS_SAMPLE_RATE
        )
        play_obj.wait_done()
    except Exception as exc:
        return f"Failed to play audio: {exc}"
    finally:
        time.sleep(0.75)  # Wait for the audio to finish playing
        resume_listening()

    return "Played generated speech."


def generate_tts_wav_b64(text: str) -> dict:
    """Generate TTS audio as WAV (base64), suitable for returning to a browser."""
    if not text or not text.strip():
        return {"audio_b64": "", "format": "wav", "sample_rate": TTS_SAMPLE_RATE}

    url = TTS_URL
    payload = {
        "model": TTS_MODEL,
        "voice": TTS_VOICE,
        "input": text,
        "response_format": "pcm",
    }

    response = requests.post(url, json=payload, timeout=60)
    response.raise_for_status()
    pcm_audio = response.content
    if len(pcm_audio) % 2 != 0:
        pcm_audio += b"\x00"

    with io.BytesIO() as buf:
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(TTS_SAMPLE_RATE)
            wf.writeframes(pcm_audio)
        wav_bytes = buf.getvalue()

    return {
        "audio_b64": base64.b64encode(wav_bytes).decode("ascii"),
        "format": "wav",
        "sample_rate": TTS_SAMPLE_RATE,
    }


def stream_tts_pcm_chunks(text: str) -> Iterator[bytes]:
    """Stream TTS audio as raw PCM int16 chunks (s16le).

    This follows the `test-tts-stream.py` approach for OpenAI-compatible audio streaming.
    Expects `TTS_URL` to be an OpenAI-compatible base URL ending in `/v1` (or similar).
    """
    if not text or not text.strip():
        return

    if not (TTS_URL.startswith("http://") or TTS_URL.startswith("https://")):
        raise RuntimeError(
            f"TTS_URL must be an OpenAI-compatible base URL (got {TTS_URL!r})."
        )

    try:
        from openai import OpenAI
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(
            "Missing dependency: openai. Install with `pip install openai`."
        ) from exc

    voice_mode = (TTS_VOICE or "").strip().lower()

    def _encode_b64_file(p: Path) -> str:
        return base64.b64encode(p.read_bytes()).decode("utf-8")

    # Voice cloning (Higgs): condition the chat with a reference audio + its transcript,
    # matching the pattern from `test-tts-stream.py`.
    use_voice_clone = voice_mode in {"belinda", "mike", "clone", "voice_clone"}
    voice_wav = Path(__file__).resolve().parents[1] / f"{TTS_VOICE}.wav"
    voice_txt = Path(__file__).resolve().parents[1] / f"{TTS_VOICE}.txt"

    client = OpenAI(
        api_key=TTS_API_KEY or "fake",
        base_url=TTS_URL,
        timeout=TTS_TIMEOUT_S,
        max_retries=1,
    )

    if use_voice_clone:
        if not voice_wav.exists() or not voice_txt.exists():
            raise RuntimeError(
                f"Voice clone requested (TTS_VOICE={TTS_VOICE!r}) but files missing: "
                f"{voice_wav} / {voice_txt}"
            )
        audio_text = voice_txt.read_text(encoding="utf-8", errors="replace")
        audio_b64 = _encode_b64_file(voice_wav)
        messages = [
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
    else:
        # Plain streamed TTS prompt (no voice conditioning).
        system_prompt = (
            "Generate audio following instruction.\n\n"
            "<|scene_desc_start|>\n"
            "Audio is recorded from a quiet room.\n"
            "<|scene_desc_end|>"
        )
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": text},
        ]

    chat_completion = client.chat.completions.create(
        messages=messages,
        model=TTS_MODEL,
        stream=True,
        modalities=["text", "audio"],
        temperature=1.0,
        top_p=0.95,
        extra_body={"top_k": 50, "audio_chunk_size": TTS_AUDIO_CHUNK_SIZE},
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
                yield base64.b64decode(audio_b64)


@tool
def convert_speech_to_text(audio: bytes):
    """Convert speech (audio bytes) to text using the Whisper endpoint."""
    print("convert_speech_to_text tool called ...")

    if not audio:
        return "No audio provided for speech-to-text."

    pause_listening()

    headers = {}
    if STT_TOKEN:
        headers["Authorization"] = f"Bearer {STT_TOKEN}"

    files = {
        "file": ("audio.wav", audio, "audio/wav"),
        "model": (None, STT_MODEL),
    }

    try:
        resp = requests.post(STT_URL, headers=headers, files=files, timeout=60)
        resp.raise_for_status()
    except requests.RequestException as exc:
        return f"Failed to transcribe audio: {exc}"

    try:
        data = resp.json()
    except ValueError:
        return "Speech-to-text response was not valid JSON."
    finally:
        resume_listening()

    transcript = data.get("text") or data.get("transcription")
    if not transcript:
        return "Speech-to-text succeeded but no transcript was returned."

    return transcript


@tool
def choose_delivery(delivery_option: str) -> dict:
    """Choose a delivery option."""
    if delivery_option == "delivery":
        estimated_delivery_time = "1 hour"
    elif delivery_option == "pickup":
        estimated_delivery_time = "30 minutes"
    else:
        estimated_delivery_time = "1 hour"

    result = {"estimated_delivery_time": estimated_delivery_time}
    print(
        f"choose_delivery   → {result['estimated_delivery_time']} estimated delivery time"
    )
    return result


@tool
def get_pizza_type(query: str) -> dict:
    """Supported pizza types."""
    pizza_type_dictionary = {
        "margherita": "Margherita",
        "pepperoni": "Pepperoni",
        "vegetarian": "Vegetarian",
        "hawaiian": "Hawaiian",
        "meatlovers": "Meat Lovers",
        "bbq_chicken": "BBQ Chicken",
        "spinach_and_mushroom": "Spinach and Mushroom",
    }
    return pizza_type_dictionary
