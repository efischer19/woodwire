# feat: Build Voice Processing Pipeline in Local Bot

## What do you want to build?

Extend the local bot (from Tickets 08–09) with an audio processing pipeline
that handles voice memo messages. When the bot receives a message with an audio
attachment, it transcribes the audio to text (STT), processes the text through
the AI backend, generates a spoken audio response (TTS), and uploads both the
text transcript and audio response to the S3 outbox.

## Acceptance Criteria

- [ ] The bot detects audio attachments by content type (`audio/webm`, `audio/mp4`, `audio/ogg`)
- [ ] Audio files are downloaded from S3 to a local temp directory for processing
- [ ] Speech-to-text transcription is performed using a local STT engine (Faster-Whisper or equivalent)
- [ ] The transcribed text is passed to the AI backend (same pluggable interface from Ticket 09)
- [ ] Text-to-speech synthesis is performed using a local TTS engine (Kokoro, Piper, or equivalent)
- [ ] The generated audio response is saved as `.mp3` format for maximum browser compatibility
- [ ] Both the text transcript and the audio response are uploaded to the S3 outbox: `outbox/{conversationId}/{timestamp}-response.md` and `outbox/{conversationId}/{timestamp}-response.mp3`
- [ ] Temp files (downloaded audio, intermediate files) are cleaned up after processing
- [ ] The entire pipeline handles a 5-minute voice memo in under 120 seconds (within the SQS visibility timeout)
- [ ] STT and TTS engine selection is configurable via environment variables (`STT_ENGINE`, `TTS_ENGINE`)
- [ ] If STT or TTS engines are not installed, the bot falls back to text-only processing (transcription skipped, no audio response) with a clear log message
- [ ] Unit tests cover audio detection, pipeline orchestration, and fallback behavior

## Implementation Notes (Optional)

**STT options:**

| Engine | Pros | Cons |
| :--- | :--- | :--- |
| Faster-Whisper | Fast, accurate, runs on CPU | Requires ~1 GB model download |
| Whisper.cpp | Very lightweight, C++ | Less Python-friendly |

**TTS options:**

| Engine | Pros | Cons |
| :--- | :--- | :--- |
| Kokoro-82M | Natural voice, tiny model | Newer, less battle-tested |
| Piper | Extremely fast, many voices | Slightly robotic |

**Pipeline flow:**

```text
audio.webm → [ffmpeg convert to wav] → [STT: wav → text]
                                              ↓
                                        [AI backend]
                                              ↓
                                   [TTS: text → audio.mp3]
                                              ↓
                              [Upload transcript + audio to S3]
```

**ffmpeg dependency:** The pipeline likely needs `ffmpeg` for audio format
conversion (webm → wav for STT input, wav → mp3 for output). Document this
as a system dependency. On Raspberry Pi, `ffmpeg` is available via `apt`.

**Performance budget:** The 120-second SQS visibility timeout (ADR-004) must
cover the entire pipeline. Typical processing times on modest hardware:

- Download from S3: < 5 seconds
- STT (5 min audio): 10–30 seconds (Faster-Whisper on CPU)
- AI processing: 5–30 seconds (depends on prompt length)
- TTS: 5–15 seconds
- Upload to S3: < 5 seconds
- **Total: 25–85 seconds** — within budget

**Raspberry Pi note:** STT and TTS models that fit in 1–2 GB of RAM are
preferred. Document minimum hardware requirements (2 GB RAM, 2 GB disk for
models).
