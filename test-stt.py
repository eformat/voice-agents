"""Test the speech to text tool."""
from pathlib import Path

from dotenv import load_dotenv

from src.tools import convert_speech_to_text


def main() -> None:
    """Test the speech to text tool."""
    load_dotenv()
    audio_path = Path("/home/mike/Downloads/hello.wav")

    if not audio_path.exists():
        print(f"Missing audio file: {audio_path}")
        return

    audio_bytes = audio_path.read_bytes()
    result = convert_speech_to_text.func(audio_bytes)
    print("Transcription:", result)


if __name__ == "__main__":
    main()
