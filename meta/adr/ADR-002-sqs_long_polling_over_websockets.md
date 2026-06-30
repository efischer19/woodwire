---
title: "ADR-002: Use SQS Long Polling Instead of WebSockets"
status: "Proposed"
date: "2026-06-30"
tags:
  - "architecture"
  - "messaging"
  - "aws"
---

## Context

* **Problem:** Woodwire needs a reliable mechanism for the local AI agent to receive new messages from the cloud. Traditional approaches use WebSockets or Server-Sent Events, which require a permanently running server process with an open inbound port. This directly conflicts with the project's zero-inbound-port security posture and zero-cost operating constraint.
* **Constraints:** The solution must stay within the AWS Free Tier (1 million SQS requests/month), require zero inbound network ports on the local machine, and achieve near-real-time responsiveness.

## Decision

We will use **AWS SQS Long Polling** as the primary message delivery mechanism between the Cloudflare edge and the local AI agent. The local bot initiates outbound HTTPS connections to SQS, holding each connection open for up to 20 seconds waiting for new messages.

## Considered Options

1. **SQS Long Polling (Chosen):** The local bot polls SQS with 20-second wait times.
    * *Pros:* Zero inbound ports. Sub-100ms delivery once a message lands. Fully within AWS Free Tier. Automatic retry via visibility timeouts. Battle-tested AWS managed service.
    * *Cons:* Slight latency for the initial poll cycle (up to 20 seconds if a message arrives just after a poll completes). Requires continuous outbound connectivity.
2. **WebSockets (e.g., API Gateway WebSocket API):** Maintain a persistent bidirectional connection.
    * *Pros:* True real-time delivery. Familiar programming model.
    * *Cons:* Requires a running server or API Gateway WebSocket endpoint ($1.00+ per million connection-minutes). Exposes an inbound endpoint. Connection management complexity (reconnects, heartbeats).
3. **S3 File Polling:** The bot periodically lists an S3 prefix for new files.
    * *Pros:* Extremely simple to implement.
    * *Cons:* High latency (poll interval dependent). Consumes S3 LIST requests (20,000 free GETs/month is tight). No built-in delivery guarantees or ordering.

## Consequences

* **Positive:** The local machine has zero attack surface. Operating costs remain at $0.00/month. Message delivery is near-instantaneous under normal conditions. SQS provides built-in retry, dead-letter queues, and exactly-once processing semantics.
* **Negative:** Requires the local bot to maintain a continuous outbound connection loop. If the local machine loses internet connectivity, messages queue in SQS (up to 14-day retention) rather than being delivered immediately.
* **Future Implications:** If bidirectional streaming is ever needed (e.g., real-time voice calls), this architecture would need to be supplemented with a WebRTC or WebSocket layer, likely requiring a new ADR.
