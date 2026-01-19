# Speech to text

Deploy Whisper Model using RHOAI and LLMd.

```bash
oc apply -f models/whisper/whisper-llmisvc.yaml
```

Test the model with an audio file.

```bash
curl -s -X POST ${MODEL_URL}/v1/audio/transcriptions \
  -H "Content-Type: multipart/form-data" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  --form file=@/home/mike/Downloads/hello.wav \
  --form model=whisper | jq .
{
  "text": " Hello.",
  "usage": {
    "type": "duration",
    "seconds": 3
  }
}
```
