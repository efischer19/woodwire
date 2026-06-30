# feat: Integrate Text Processing Pipeline with Pluggable AI Backend

## What do you want to build?

Extend the local bot (built in Ticket 08) with the text processing pipeline:
extract the user's message from the SQS payload, pass it to the AI backend,
and write the AI's response to the S3 outbox. The AI integration must be
pluggable — defined as an interface that can be swapped for any LLM backend
(OpenClaw, Ollama, OpenAI API, etc.) without modifying the core bot logic.

## Acceptance Criteria

- [ ] An abstract `AIBackend` interface (Python ABC or Protocol) is defined with a `process(message: str, attachments: list[str]) -> str` method
- [ ] A concrete `OpenClawBackend` implementation calls the local OpenClaw agent and returns its text response
- [ ] A `MockBackend` implementation is provided for testing that echoes the input message
- [ ] The bot reads the `AI_BACKEND` environment variable to select which backend to use (default: `openclaw`)
- [ ] The bot downloads any S3 attachments referenced in the message payload to a local temp directory before passing them to the AI backend
- [ ] The AI's text response is written to `outbox/{conversationId}/{timestamp}-response.md` in S3
- [ ] Temp files are cleaned up after processing
- [ ] The full end-to-end text flow works: SQS message → download attachments → AI processing → S3 outbox write → SQS message delete
- [ ] Unit tests cover the AI backend interface, mock backend, S3 read/write, and the orchestration logic
- [ ] Integration test (can be manual) demonstrates a full round-trip with the mock backend

## Implementation Notes (Optional)

**Pluggable architecture pattern:**

```python
class AIBackend(Protocol):
    def process(self, message: str, attachments: list[str]) -> str: ...

class OpenClawBackend:
    def process(self, message: str, attachments: list[str]) -> str:
        # Call local OpenClaw agent
        ...

class MockBackend:
    def process(self, message: str, attachments: list[str]) -> str:
        return f"Echo: {message}"
```

**S3 outbox key format:**

```text
outbox/{conversationId}/{timestamp}-response.md
```

The response is written as a markdown file so it renders nicely in the PWA.

**Attachment handling:** Download attachments to `/tmp/woodwire/{conversationId}/`
before processing. Pass local file paths to the AI backend. Clean up the temp
directory after the response is written to S3.

**OpenClaw integration:** The specific OpenClaw API/CLI interface will depend
on the user's local setup. The `OpenClawBackend` should accept configuration
via environment variables (`OPENCLAW_HOST`, `OPENCLAW_PORT`, etc.). If OpenClaw
is not available, the bot should log a clear error and fall back to the mock
backend rather than crashing.
