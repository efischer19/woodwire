---
title: "ADR-004: Use SQS Visibility Timeouts Before Message Deletion"
status: "Proposed"
date: "2026-06-30"
tags:
  - "architecture"
  - "reliability"
  - "aws"
---

## Context

* **Problem:** When the local bot receives an SQS message, it must process the AI request (which may take 10–60 seconds for complex prompts or TTS generation) before writing a response to S3. If the bot crashes or loses connectivity mid-processing, the message would be lost if it was already deleted from the queue.
* **Constraints:** Messages must be processed exactly once under normal conditions. Lost messages are unacceptable — the user must always receive a response or be notified of failure.

## Decision

The local bot will **hide** each SQS message upon receipt using a 120-second Visibility Timeout rather than immediately deleting it. The message is permanently deleted from the queue **only after** the bot has successfully written the response to S3 and confirmed the write. If the bot crashes before deletion, the message automatically reappears in the queue after the timeout expires.

## Considered Options

1. **Visibility Timeout then Delete (Chosen):** Hide message on receipt; delete only after confirmed S3 write.
    * *Pros:* Automatic retry on failure. No message loss. Simple to implement with the SQS SDK. Configurable timeout per message.
    * *Cons:* If the bot is consistently failing, the same message retries repeatedly until it hits the dead-letter queue threshold.
2. **Immediate Deletion:** Delete the message as soon as it is received, before processing.
    * *Pros:* Simplest implementation. No duplicate processing risk.
    * *Cons:* Message is permanently lost if processing fails. Unacceptable for a communication channel.
3. **SQS FIFO with Exactly-Once Processing:** Use an SQS FIFO queue with deduplication.
    * *Pros:* Guaranteed ordering and exactly-once delivery.
    * *Cons:* FIFO queues have lower throughput limits. More complex configuration. Ordering is not a requirement for this use case.

## Consequences

* **Positive:** Zero message loss under crash conditions. The dead-letter queue catches permanently failing messages for human review. The user's message is never silently dropped.
* **Negative:** A crashed bot may cause the same message to be processed twice if it partially completed (mitigated by idempotent S3 writes — overwriting the same key is safe). The 120-second timeout must be tuned to exceed the worst-case processing time.
* **Future Implications:** If processing times grow beyond 120 seconds (e.g., very large audio files), the timeout can be extended up to 12 hours per SQS limits. A heartbeat mechanism could also be added to extend visibility dynamically.
