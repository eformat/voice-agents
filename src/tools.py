"""Domain-specific tools for voice agents.

This module provides specialized tools:
- convert_text_to_speech: For text to speech agent
"""

import requests
from langchain.tools import tool
import simpleaudio as sa

@tool
def convert_text_to_speech(text: str):
    """Convert text to speech and play the generated audio."""

    if not text or not text.strip():
        return "No text provided for speech synthesis."

    if sa is None:
        return "Audio playback is unavailable because simpleaudio is not installed."

    url = "BASE_URL"
    payload = {
        "model": "higgs-audio-v2-generation-3B-base",
        "voice": "belinda",
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
        play_obj = sa.play_buffer(
            pcm_audio, num_channels=1, bytes_per_sample=2, sample_rate=24000
        )
        play_obj.wait_done()
    except Exception as exc:
        return f"Failed to play audio: {exc}"

    return "Played generated speech."
