"""An example showing how to use vLLM to serve multimodal models and run online inference with OpenAI client."""
import argparse
import base64
import os
import time
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


def run_voice_clone(stream: bool = False) -> None:
    """Run the voice clone task."""
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
    chat_completion = client.chat.completions.create(
        messages=messages,
        model=model,
        max_completion_tokens=500,
        stream=stream,
        modalities=["text", "audio"],
        temperature=1.0,
        top_p=0.95,
        extra_body={"top_k": 50, "audio_chunk_size": 10},
        stop=["<|eot_id|>", "<|end_of_text|>", "<|audio_eos|>"],
    )
    if stream:
        audio_bytes_io = BytesIO()
        i = 0
        first_audio_latency = None
        for chunk in chat_completion:
            if (
                chunk.choices
                and hasattr(chunk.choices[0].delta, "audio")
                and chunk.choices[0].delta.audio
            ):
                if first_audio_latency is None:
                    first_audio_latency = time.time() - start_time
                audio_bytes = base64.b64decode(chunk.choices[0].delta.audio["data"])
                audio_bytes_io.write(audio_bytes)
                audio_data = np.frombuffer(audio_bytes, dtype=np.int16)
                i += 1
        audio_bytes_io.seek(0)
        audio_data = np.frombuffer(audio_bytes_io.getvalue(), dtype=np.int16)
        print("Saving the audio to file")
        print(f"First audio latency: {first_audio_latency * 1000} ms")
        print(f"Total audio latency: {(time.time() - start_time) * 1000} ms")
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
        run_voice_clone(args.stream)
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
    parser.add_argument("--stream", action="store_true", help="Stream the audio.")
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
