# Local Bot

The Woodwire local bot is a long-running Python process that listens for inbound messages on an AWS SQS queue, processes them with a local LLM backend (OpenClaw, Ollama, or mock), and stores responses in a private S3 bucket for the PWA to retrieve.

## Architecture

The bot implements the outbound-only pattern:

```text
[ AWS SQS Queue ]  ──►  [ Local Bot ]  ──►  [ Private S3 Bucket ]
    (inbound)        (polls, processes)     (outbox/ responses)
        │                                           ▲
        │                                           │
        └───────────── Long-poll, 20s wait ────────┘
```

The bot never initiates outbound connections back to the PWA or Cloudflare Worker; all communication is pull-based or push-to-storage.

## Configuration

The bot loads configuration from environment variables or a repository-local `.env` file. The `.env` file is loaded before reading AWS, backend, and encryption settings, without overriding already-exported environment variables.

### Required Variables

| Variable | Description |
| :--- | :--- |
| `AWS_ACCESS_KEY_ID` | AWS IAM access key |
| `AWS_SECRET_ACCESS_KEY` | AWS IAM secret access key |
| `AWS_REGION` | AWS region (e.g., `us-east-1`) |
| `SQS_QUEUE_URL` | Full URL to your chat queue (e.g., `https://sqs.us-east-1.amazonaws.com/123456789012/woodwire-chat`) |
| `S3_BUCKET_NAME` | Name of the private S3 bucket storing `outbox/` responses |

### Optional Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `AI_BACKEND` | `openclaw` | LLM backend: `openclaw`, `ollama`, or `mock` |
| `AI_BACKEND_TOKEN` | — | Auth token for backend API requests (optional; if present, sent as bearer token in `Authorization` header) |
| `OPENCLAW_URL` | — | Override the full OpenClaw inference URL (e.g., `http://10.0.0.5:8080/process`) |
| `OPENCLAW_HOST` | `127.0.0.1` | OpenClaw server hostname (used if `OPENCLAW_URL` not set) |
| `OPENCLAW_PORT` | `8080` | OpenClaw server port |
| `OPENCLAW_PATH` | `/process` | OpenClaw inference endpoint path |
| `OLLAMA_URL` | `http://127.0.0.1:11434/api/generate` | Ollama inference URL |
| `OLLAMA_MODEL` | `mistral` | Ollama model name |
| `WOODWIRE_E2EE_KEY` | — | Base64-encoded 32-byte AES-256-GCM key for client-side encryption (optional) |
| `LOG_FORMAT` | `json` | Log format: `json` or `text`. Use `text` for human-readable logs. |
| `STT_ENGINE` | `faster-whisper` | Speech-to-text engine: `faster-whisper` or `openai-whisper` |
| `TTS_ENGINE` | `piper` | Text-to-speech engine: `piper` |
| `PIPER_MODEL_PATH` | — | Path to local Piper voice model file (enables TTS) |
| `PIPER_MODEL` | — | Fallback alias for `PIPER_MODEL_PATH` |

Example `.env` file:

```dotenv
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
AWS_REGION=us-east-1
SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/woodwire-chat
S3_BUCKET_NAME=woodwire-chat-bucket-org-id
AI_BACKEND=openclaw
OPENCLAW_URL=http://127.0.0.1:8080/process
WOODWIRE_E2EE_KEY=base64-encoded-32-byte-aes-key-here
LOG_FORMAT=json
```

## Installation

### Prerequisites

- Python 3.10+
- [uv](https://docs.astral.sh/uv/getting-started/installation/) for dependency management
- AWS IAM user credentials with SQS and S3 permissions

### Setup Steps

1. **Install dependencies:**

   ```bash
   cd bot
   uv sync
   ```

2. **Activate the virtual environment:**

   ```bash
   source .venv/bin/activate
   ```

   Or use `uv run` to run commands without activation:

   ```bash
   PYTHONPATH=.. uv run python main.py
   ```

3. **Configure environment variables** (see Configuration section above)

## Running the Bot

### Local Development

```bash
cd bot
source .venv/bin/activate
python main.py
```

### Using uv run

```bash
cd bot
PYTHONPATH=.. uv run python main.py
```

### With Mock Backend (for Testing)

No OpenClaw setup required:

```bash
cd bot
AI_BACKEND=mock uv run python main.py
```

The mock backend responds with a fixed test message for smoke testing.

### With Human-Readable Logs

```bash
cd bot
LOG_FORMAT=text python main.py
```

## AI Backend Configuration

### OpenClaw (Default)

Requires a running OpenClaw server (e.g., via Docker or local build).

```bash
# Start OpenClaw (example with Docker)
docker run -p 8080:8080 jatincpl/openclaw:latest

# Start the bot
cd bot
OPENCLAW_URL=http://127.0.0.1:8080/process python main.py
```

To use a remote OpenClaw instance:

```bash
OPENCLAW_URL=http://openclaw.example.com:8080/process python main.py
```

### Ollama

Requires a running Ollama server.

```bash
# Start Ollama
ollama serve

# In another terminal, pull a model
ollama pull mistral

# Start the bot
cd bot
AI_BACKEND=ollama OLLAMA_MODEL=mistral python main.py
```

### Mock Backend

For smoke tests and CI/CD:

```bash
cd bot
AI_BACKEND=mock python main.py
```

## Voice Support

The bot automatically processes audio attachments (`audio/webm`, `audio/mp4`, `audio/ogg`) if local voice engines are available.

### Prerequisites

1. **FFmpeg** (transcoding and STT/TTS)

   ```bash
   # macOS
   brew install ffmpeg

   # Ubuntu/Debian
   sudo apt-get install ffmpeg

   # Fedora/RHEL
   sudo dnf install ffmpeg
   ```

2. **Speech-to-Text (STT)**: faster-whisper (default)

   - Automatically installed as a dependency via `uv sync`

3. **Text-to-Speech (TTS)**: Piper

   - Download a Piper voice model: https://github.com/rhasspy/piper/releases
   - Set `PIPER_MODEL_PATH` to the `.onnx` model file

   ```bash
   # Example: Download a voice model
   wget https://github.com/rhasspy/piper/releases/download/v1.0.0/en_US-ryan-medium.onnx

   # Run the bot with voice support
   PIPER_MODEL_PATH=/path/to/en_US-ryan-medium.onnx python main.py
   ```

### Testing Voice Support

1. Send an audio file from the PWA
2. Check bot logs for voice processing messages
3. Verify the response includes an MP3 file in S3 (`outbox/<conversation_id>/response.mp3`)

If voice engines are unavailable, the bot logs a warning and falls back to text-only processing without uploading MP3 responses.

### Resource Requirements

- **RAM**: At least 2 GB for voice models on Raspberry Pi-class hardware
- **Disk**: Roughly 2 GB for local voice models

## Encryption Support

### Schema Version 2: Client-Side E2EE

The bot supports client-side AES-256-GCM end-to-end encryption (schema version 2).

**To enable:**

1. Generate a 32-byte AES key and encode it as base64:

   ```bash
   openssl rand -base64 32
   ```

2. Set `WOODWIRE_E2EE_KEY` on the bot and save the same key in the PWA settings:

   ```bash
   export WOODWIRE_E2EE_KEY=your-base64-encoded-32-byte-key
   python main.py
   ```

3. The Worker is explicitly designed **not** to receive the encryption key—it's only available to the browser and the local bot.

**Important:** Both the bot and PWA must use the same key. If keys mismatch, decryption fails and messages are logged as errors.

### Schema Version 1: Legacy (Unencrypted)

For backwards compatibility, the bot continues to support unencrypted messages (schema version 1).

## Testing

### Unit Tests

```bash
cd bot
python -m unittest discover -s tests -v
```

### Integration Test (Manual Smoke Test)

1. Set `AI_BACKEND=mock`
2. Run the bot: `python main.py`
3. Send a test message via the PWA
4. Verify the bot logs the message and posts a response

## Logging

### JSON Structured Logging (Default)

Each log line is a JSON object with:

```json
{
  "timestamp": "2024-07-09T11:45:52.362+00:00",
  "level": "INFO",
  "logger": "bot.main",
  "message": "Processing message from queue",
  "conversationId": "conv-123-abc",
  "messageId": "msg-456-def"
}
```

This format enables log aggregation tools (CloudWatch, ELK, Loki, journald) to parse and filter logs without fragile regex patterns.

### Human-Readable Logging

```bash
LOG_FORMAT=text python main.py
```

## Troubleshooting

### Bot won't start: "Missing required environment variable"

Check that all required variables are set (see Configuration section). Use `printenv` to verify.

### SQS Connection Error

- Verify AWS credentials have `sqs:ReceiveMessage`, `sqs:DeleteMessage`, and `sqs:GetQueueAttributes` permissions
- Confirm `SQS_QUEUE_URL` is correct (from CloudFormation stack outputs)
- Check AWS region matches your queue region

### S3 Connection Error

- Verify AWS credentials have `s3:PutObject` and `s3:GetObject` permissions
- Confirm `S3_BUCKET_NAME` is correct and exists

### Backend Connection Refused

- For OpenClaw: ensure `OPENCLAW_URL` is reachable and the server is running
- For Ollama: ensure Ollama is running and the model is pulled
- Use `curl` to test: `curl http://backend-url:port/health`

### Voice Processing Warnings

- Install FFmpeg: `brew install ffmpeg` or `apt-get install ffmpeg`
- Download a Piper model and set `PIPER_MODEL_PATH`
- Check bot logs for specific error messages

### High Memory Usage

- Voice models consume ~500 MB to 2 GB depending on quality
- Consider using smaller models or disabling voice support if resources are constrained

## Performance Tuning

- **Long-poll wait**: Adjust `LONG_POLL_WAIT_SECONDS` in `main.py` (default 20s). Longer waits reduce AWS API calls but increase message latency.
- **Visibility timeout**: Adjust `VISIBILITY_TIMEOUT_SECONDS` in `main.py` (default 120s). Longer timeouts allow more processing time but delay dead-letter queue routing.
- **Log level**: Set `LOG_LEVEL=WARNING` or `ERROR` to reduce I/O in production.

## See Also

- [QUICK_START.md](../QUICK_START.md) — Full setup guide
- [README.md](../README.md) — Architecture overview
- [worker/README.md](../worker/README.md) — Cloudflare Worker documentation
- [infra/README.md](../infra/README.md) — AWS infrastructure documentation
