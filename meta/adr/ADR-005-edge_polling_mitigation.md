---
title: "ADR-005: Poll Cloudflare Worker for Response Status Instead of S3 Directly"
status: "Proposed"
date: "2026-06-30"
tags:
  - "architecture"
  - "frontend"
  - "cost"
  - "cloudflare"
---

## Context

* **Problem:** After sending a message, the PWA needs to check whether the AI has responded. Polling S3 directly for new objects in the `outbox/` prefix consumes S3 GET/LIST requests. The AWS Free Tier provides only 20,000 GET requests and 2,000 LIST requests per month. A PWA polling every 2 seconds would exhaust this quota in under 12 hours.
* **Constraints:** The solution must keep AWS API usage well within free tier limits. The PWA must not hold AWS credentials or have direct S3 access for reads.

## Decision

The PWA will poll the **Cloudflare Worker** for response status rather than hitting S3 directly. The Worker acts as a caching proxy — it checks S3 for new responses and caches the result at the edge with a short TTL (2–5 seconds). Multiple PWA polls within the cache window are served from Cloudflare's edge cache without touching AWS.

## Considered Options

1. **Cloudflare Worker as Polling Proxy (Chosen):** PWA polls the Worker; Worker caches S3 status checks.
    * *Pros:* Dramatically reduces S3 API calls (one S3 call per cache TTL window, regardless of PWA poll frequency). Cloudflare Workers free tier allows 100,000 requests/day. Rate limiting can be enforced at the edge. PWA never touches AWS directly for reads.
    * *Cons:* Adds a small amount of latency (cache TTL). Worker logic is slightly more complex.
2. **Direct S3 Polling from PWA:** PWA polls S3 using pre-signed GET URLs.
    * *Pros:* Simpler architecture. No Worker involvement for reads.
    * *Cons:* Exhausts S3 free tier quickly. Requires generating and managing pre-signed read URLs. No rate limiting.
3. **S3 Event Notifications → SNS → Push:** Use S3 event notifications to push to the PWA.
    * *Pros:* True push-based notification. No polling at all.
    * *Cons:* Requires SNS/Lambda or a WebSocket endpoint. Adds cost and complexity. Violates the zero-cost constraint.

## Consequences

* **Positive:** S3 API usage drops to a fraction of free tier limits. Cloudflare's edge cache absorbs the polling load for free. Rate limiting at the Worker prevents abuse. The PWA remains stateless and credential-free.
* **Negative:** Response detection has a latency floor equal to the cache TTL (2–5 seconds). The Worker requires cache management logic.
* **Future Implications:** If real-time delivery becomes critical, the Worker could be enhanced with Cloudflare Durable Objects to implement server-sent events or a WebSocket upgrade, but this would exceed the free tier.
