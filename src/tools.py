"""Domain-specific tools for voice agents.

This module provides specialized tools:
- convert_text_to_speech: For text to speech agent
- convert_speech_to_text: For speech to text agent
- listen_for_user_speech: Capture microphone audio and transcribe it
"""

import io
import os
import wave

import requests
import simpleaudio as sa
import sounddevice as sd
from dotenv import load_dotenv
from langchain.tools import tool

load_dotenv()

TTS_URL = os.getenv("TTS_URL", "TTS_URL")
TTS_MODEL = os.getenv("TTS_MODEL", "TTS_MODEL")
TTS_VOICE = os.getenv("TTS_VOICE", "TTS_VOICE")

STT_URL = os.getenv("STT_URL", "STT_URL")
STT_MODEL = os.getenv("STT_MODEL", "STT_MODEL")
STT_TOKEN = os.getenv("STT_TOKEN", "STT_TOKEN")

LISTEN_DURATION = float(os.getenv("LISTEN_DURATION", "5.0"))
SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # bytes (int16)
_LISTENING_PAUSED = False


def pause_listening() -> None:
    """Signal to pause background listening callbacks."""
    global _LISTENING_PAUSED
    _LISTENING_PAUSED = True


def resume_listening() -> None:
    """Signal to resume background listening callbacks."""
    global _LISTENING_PAUSED
    _LISTENING_PAUSED = False


def is_listening_paused() -> bool:
    """Return True if listening is currently paused."""
    return _LISTENING_PAUSED


@tool
def add_to_order(item: str) -> str:
    """Add an item to the customer's order."""
    print("add_to_order tool called with item: ", item)
    return f"Added {item} to the order."


@tool
def convert_text_to_speech(text: str):
    """Convert text to speech and play the generated audio."""
    print("convert_text_to_speech tool called with text: ", text)

    if not text or not text.strip():
        return "No text provided for speech synthesis."

    if sa is None:
        return "Audio playback is unavailable because simpleaudio is not installed."

    url = TTS_URL
    payload = {
        "model": TTS_MODEL,
        "voice": TTS_VOICE,
        "input": text,
        "response_format": "pcm",
    }

    try:
        response = requests.post(url, json=payload, timeout=30)
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
        pause_listening()
        play_obj = sa.play_buffer(
            pcm_audio, num_channels=1, bytes_per_sample=2, sample_rate=24000
        )
        play_obj.wait_done()
    except Exception as exc:
        return f"Failed to play audio: {exc}"
    finally:
        resume_listening()

    return "Played generated speech."


@tool
def convert_speech_to_text(audio: bytes):
    """Convert speech (audio bytes) to text using the Whisper endpoint."""
    if not audio:
        return "No audio provided for speech-to-text."

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

    transcript = data.get("text") or data.get("transcription")
    if not transcript:
        return "Speech-to-text succeeded but no transcript was returned."

    return transcript


@tool
def listen_for_user_speech(duration: float | None = None) -> str:
    """Record microphone audio for `duration` seconds and return transcription."""
    record_seconds = duration or LISTEN_DURATION
    try:
        frames = sd.rec(
            int(record_seconds * SAMPLE_RATE),
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="int16",
        )
        sd.wait()
    except Exception as exc:
        return f"Failed to record audio: {exc}"

    # Wrap PCM into WAV for the STT service
    with io.BytesIO() as buffer:
        with wave.open(buffer, "wb") as wav_file:
            wav_file.setnchannels(CHANNELS)
            wav_file.setsampwidth(SAMPLE_WIDTH)
            wav_file.setframerate(SAMPLE_RATE)
            wav_file.writeframes(frames.tobytes())
        wav_bytes = buffer.getvalue()

    transcript = convert_speech_to_text.func(wav_bytes)
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
    print(f"   → {result['estimated_delivery_time']} estimated delivery time")
    return result


@tool
def choose_pizza(pizza_type: str) -> dict:
    """Choose a pizza type."""
    if pizza_type == "margherita":
        pizza_type = "Margherita"
    elif pizza_type == "pepperoni":
        pizza_type = "Pepperoni"
    elif pizza_type == "vegetarian":
        pizza_type = "Vegetarian"
    elif pizza_type == "hawaiian":
        pizza_type = "Hawaiian"
    elif pizza_type == "meatlovers":
        pizza_type = "Meat Lovers"
    elif pizza_type == "bbq_chicken":
        pizza_type = "BBQ Chicken"
    elif pizza_type == "spinach_and_mushroom":
        pizza_type = "Spinach and Mushroom"
    else:
        pizza_type = "Margherita"

    return {"pizza_type": pizza_type}
