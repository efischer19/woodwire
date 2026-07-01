# feat: Switch Bot Logging to Structured JSON Format

## What do you want to build?

Replace the bot's plain-text log format with structured JSON logging. The
current format (`%(asctime)s %(levelname)s %(message)s`) is human-readable
but cannot be parsed by log aggregation tools (CloudWatch Logs, journald JSON
export, Loki, etc.) without fragile regex patterns. Structured logs allow
filtering by `conversationId`, `messageId`, `level`, and error type — critical
for debugging asynchronous failures in a disconnected system where the bot
runs on a user's local machine.

## Acceptance Criteria

- [ ] `bot/main.py` `configure_logging()` uses a JSON-formatted log output where each line is a valid JSON object
- [ ] Each log entry includes at minimum: `timestamp` (ISO 8601), `level`, `message`, and `logger` fields
- [ ] Log entries emitted during message processing include a `conversationId` field (use Python's `logging` extras or a context variable)
- [ ] Log entries emitted during message processing include a `messageId` field when available
- [ ] The JSON formatter does not add a dependency beyond the Python standard library (use `json.dumps` in a custom `Formatter` subclass)
- [ ] The `--human` or `LOG_FORMAT=text` environment variable can be set to fall back to the existing plain-text format for local development readability
- [ ] Existing log messages are not changed in content — only their output format changes
- [ ] All existing bot unit tests pass without modification (tests that assert log output may need format-aware assertions)
- [ ] A brief comment in `configure_logging()` explains the JSON format choice

## Implementation Notes (Optional)

**Custom JSON formatter:**

```python
class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "timestamp": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if hasattr(record, "conversationId"):
            entry["conversationId"] = record.conversationId
        if hasattr(record, "messageId"):
            entry["messageId"] = record.messageId
        if record.exc_info and record.exc_info[1]:
            entry["exception"] = str(record.exc_info[1])
        return json.dumps(entry)
```

**Passing context fields:** Use `self.logger.info("...", extra={"conversationId": cid})`
in `handle_message` and downstream methods.

**Files to modify:**

- `bot/main.py`: Add `JsonFormatter` class, update `configure_logging()`, add
  `extra` dicts to log calls in `handle_message` and `process_payload`
- `bot/tests/test_main.py`: Update any assertions that check raw log output
  format (if any exist)
