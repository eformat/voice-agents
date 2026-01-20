# Advanced

## Voice Cloning

i wanna be like **mike**

```bash
curl -X POST $MODEL_URL/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "model": "higgs-audio-v2-generation-3B-base",
    "voice": "mike",
    "input": "What would you like on your pizza?",
    "response_format": "pcm"
  }' \
  --output - | ffmpeg -f s16le -ar 24000 -ac 1 -i pipe:0 -f wav - | ffplay -nodisp -autoexit -
```

## Extension Exercises

How Might We extend the app?

- Add $$ pricing for pizzas
- Add S|M|L|XL pizza size options
- Extract more session data (not just pizza type)
- Add messaging/storage for your oders
