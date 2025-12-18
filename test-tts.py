"""Test the text to speech tool."""
from dotenv import load_dotenv

from src.tools import convert_text_to_speech


def main() -> None:
    """Test the text to speech tool."""
    load_dotenv()
    result = convert_text_to_speech.func("Testing playback from tool.")
    print("TTS result:", result)


if __name__ == "__main__":
    main()
