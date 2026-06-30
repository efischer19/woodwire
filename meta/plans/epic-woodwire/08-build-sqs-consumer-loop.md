# feat: Build SQS Consumer Loop with Visibility Timeout Handling

## What do you want to build?

Build the Python-based local bot that continuously polls the SQS queue for new
messages, processes them, and writes responses to S3. This is the execution
core of Woodwire — it runs on the user's local machine (PC, home server, or
Raspberry Pi) and initiates only outbound HTTPS connections, maintaining the
zero-inbound-port security posture.

## Acceptance Criteria

- [ ] A Python script in `bot/` implements a continuous SQS long-poll loop with 20-second wait times
- [ ] On message receipt, the script extends the message's visibility timeout to 120 seconds (per ADR-004)
- [ ] After successful processing and S3 response write, the message is deleted from the queue
- [ ] If processing fails, the message is NOT deleted — it returns to the queue after the visibility timeout expires
- [ ] The script handles network connectivity loss gracefully with exponential backoff reconnection (starting at 1 second, max 60 seconds)
- [ ] The script logs all significant events (message received, processing started, response written, errors) to stdout
- [ ] Configuration is read from environment variables: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `SQS_QUEUE_URL`, `S3_BUCKET_NAME`
- [ ] A `requirements.txt` (or `pyproject.toml`) in `bot/` lists all dependencies
- [ ] The script can be run with `python bot/main.py` (or equivalent entry point)
- [ ] The script includes a graceful shutdown handler (SIGINT/SIGTERM) that finishes processing the current message before exiting
- [ ] Unit tests cover the poll loop, visibility timeout extension, message deletion, and error handling

## Implementation Notes (Optional)

Use `boto3` for AWS SDK interactions. The long-poll loop structure:

```python
while running:
    try:
        response = sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=1,
            WaitTimeSeconds=20,
        )
        if messages := response.get("Messages", []):
            handle_message(messages[0])
    except (BotoCoreError, ClientError) as e:
        log.error(f"SQS error: {e}")
        backoff_sleep()
```

**Graceful shutdown:** Use Python's `signal` module to catch SIGINT and
SIGTERM. Set a `running = False` flag that the poll loop checks.

**Message payload format** (must match the Worker's SQS message format):

```json
{
  "conversationId": "uuid",
  "type": "text",
  "text": "Hello, AI!",
  "attachments": ["attachments/uuid/file.png"],
  "timestamp": "2026-06-30T00:00:00Z"
}
```

**Connectivity resilience:** The exponential backoff should cap at 60 seconds
and reset to 1 second after a successful poll. This ensures the bot recovers
quickly from brief network blips but doesn't hammer the network during extended
outages.

**Raspberry Pi compatibility:** Keep dependencies minimal. `boto3` is the only
required dependency. Avoid heavy ML libraries in this ticket — the AI
integration (Ticket 09) and voice pipeline (Ticket 14) are separate.
