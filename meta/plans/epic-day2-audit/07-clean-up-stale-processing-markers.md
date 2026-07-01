# feat: Clean Up Stale Processing Markers on DLQ Routing

## What do you want to build?

Address the stale processing marker problem where `outbox/{conversationId}/processing.json`
remains in S3 indefinitely after a message fails all retry attempts and routes
to the dead-letter queue. Currently, the bot writes this marker at the start of
processing but only removes it implicitly when the response file is written.
If processing fails, the marker stays, and the Worker's status endpoint
permanently reports `"status": "processing"` for that conversation — the PWA
polls until its 5-minute timeout and then shows a generic "taking longer than
expected" message with no resolution.

This ticket adds a cleanup mechanism so stale markers do not mislead the status
endpoint.

## Acceptance Criteria

- [ ] `bot/main.py` `handle_message` wraps the processing and response-write logic in a try/except that explicitly deletes the `processing.json` marker from S3 if an unrecoverable error occurs
- [ ] The marker cleanup only runs on exceptions that will cause the message to be retried (the message is NOT deleted from SQS, so it will return after the visibility timeout)
- [ ] If the marker deletion itself fails (S3 error), the failure is logged as a warning but does not mask the original processing error
- [ ] The existing behavior is preserved: on success, the response file is written and the marker is left in place (the status endpoint correctly reports `"complete"` because a response file exists alongside the marker)
- [ ] A new unit test verifies that when `process_payload` raises an exception, `delete_object` is called for the processing marker key
- [ ] A new unit test verifies that when the marker deletion fails, the original exception is still raised

## Implementation Notes (Optional)

**Change in `handle_message`:**

```python
def handle_message(self, message: dict[str, Any]) -> str:
    # ... existing setup code ...
    self.write_processing_marker(conversation_id)

    try:
        processed_payload = self.process_payload(conversation_id, payload)
    except Exception:
        self.delete_processing_marker(conversation_id)
        raise

    response_key = self.write_response(...)
    # ... existing cleanup code ...

def delete_processing_marker(self, conversation_id: str) -> None:
    key = f"outbox/{conversation_id}/{PROCESSING_MARKER_KEY}"
    try:
        self.s3_client.delete_object(
            Bucket=self.config.s3_bucket_name,
            Key=key,
        )
    except Exception as error:
        self.logger.warning(
            "Failed to delete processing marker %s: %s", key, error
        )
```

**Files to modify:**

- `bot/main.py`: Add `delete_processing_marker` method, wrap `process_payload`
  call in try/except in `handle_message`
- `bot/tests/test_main.py`: Add tests for marker cleanup on failure
