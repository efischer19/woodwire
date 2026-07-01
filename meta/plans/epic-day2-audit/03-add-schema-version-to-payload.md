# feat: Add Schema Version to SQS Message Payload Contract

## What do you want to build?

Introduce a `schemaVersion` field to the SQS message payload emitted by the
Cloudflare Worker and consumed by the Python bot. This enables forward-compatible
schema evolution so that future payload changes (new media types, metadata
fields, conversation threading) do not crash the bot on unrecognized content.
The bot must validate the schema version and reject messages with unsupported
versions by logging a clear error and allowing the message to route to the DLQ
rather than silently ignoring new fields.

## Acceptance Criteria

- [ ] `worker/src/index.js` adds `schemaVersion: 1` to the SQS message payload in `handleMessageRequest` (alongside `conversationId`, `text`, `attachments`, `createdAt`)
- [ ] `bot/main.py` adds a `read_schema_version(payload)` function that extracts and validates the `schemaVersion` field
- [ ] `read_schema_version` returns the integer version if present, or defaults to `1` if the field is missing (backward compatibility with messages already in the queue)
- [ ] `read_schema_version` raises `ValueError` if the version is present but is not a positive integer
- [ ] `handle_message` in `bot/main.py` calls `read_schema_version` and logs a warning if the version is greater than the bot's `SUPPORTED_SCHEMA_VERSION` constant (set to `1`)
- [ ] If the schema version is greater than `SUPPORTED_SCHEMA_VERSION`, the bot raises `ValueError` with a clear message so the message is not deleted and eventually routes to the DLQ
- [ ] Worker unit tests verify that the SQS payload includes `schemaVersion: 1`
- [ ] Bot unit tests cover `read_schema_version` for: missing field (defaults to 1), valid version, invalid type, unsupported future version
- [ ] The `worker/README.md` API contract documentation is updated to include `schemaVersion` in the message payload schema

## Implementation Notes (Optional)

**Worker change** (in `handleMessageRequest`):

```javascript
const payload = {
  schemaVersion: 1,
  attachments: body.attachments,
  conversationId,
  createdAt: new Date().toISOString(),
  text: body.text,
};
```

**Bot change** (new function in `bot/main.py`):

```python
SUPPORTED_SCHEMA_VERSION = 1

def read_schema_version(payload: dict[str, Any]) -> int:
    version = payload.get("schemaVersion", 1)

    if not isinstance(version, int) or version < 1:
        raise ValueError("Message schemaVersion must be a positive integer")

    return version
```

**Files to modify:**

- `worker/src/index.js`: Add `schemaVersion: 1` to payload object
- `worker/src/index.test.js`: Assert `schemaVersion` in SQS payload tests
- `bot/main.py`: Add `read_schema_version`, call it in `handle_message`
- `bot/tests/test_main.py`: Add tests for `read_schema_version`
- `worker/README.md`: Update payload documentation
