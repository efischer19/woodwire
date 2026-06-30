---
title: "ADR-003: Use Direct-to-S3 Pre-signed Uploads for Media"
status: "Proposed"
date: "2026-06-30"
tags:
  - "architecture"
  - "media"
  - "aws"
  - "security"
---

## Context

* **Problem:** The PWA needs to upload binary media (images, voice memos, files) to the backend. Passing binary data through a Cloudflare Worker or API Gateway has payload size limits (typically 100MB for Workers, 10MB for API Gateway) and consumes Worker CPU time for data proxying.
* **Constraints:** Uploads must work for files up to ~25MB (voice memos, images). The Cloudflare Worker free tier has a 10ms CPU time limit per request. All uploads must be authenticated and scoped to prevent abuse.

## Decision

The frontend will request **short-lived, pre-signed S3 PUT URLs** from the Cloudflare Worker, then upload media directly to S3 using those URLs. The Worker generates the pre-signed URL (scoped to a specific S3 key and expiring in 5 minutes) without ever touching the binary payload.

## Considered Options

1. **Pre-signed S3 URLs (Chosen):** Worker generates a scoped, time-limited upload URL; frontend uploads directly to S3.
    * *Pros:* No payload size limits from the Worker. Zero Worker CPU spent on data transfer. S3 handles upload reliability (multipart, retries). The pre-signed URL is scoped to a single key and expires quickly.
    * *Cons:* Slightly more complex frontend logic (two-step: get URL, then upload). Requires CORS configuration on the S3 bucket.
2. **Proxy through Cloudflare Worker:** The Worker receives the binary payload and forwards it to S3.
    * *Pros:* Simpler frontend (single POST request).
    * *Cons:* Subject to Worker payload and CPU time limits. Doubles bandwidth costs. Worker becomes a bottleneck for large files.
3. **Proxy through API Gateway + Lambda:** Use AWS API Gateway with a Lambda function to handle uploads.
    * *Pros:* Full AWS-native solution.
    * *Cons:* API Gateway has a 10MB payload limit. Lambda adds cold-start latency and cost. Exceeds the zero-cost constraint.

## Consequences

* **Positive:** Supports arbitrarily large uploads within S3 limits. Worker remains lightweight and fast. Pre-signed URLs are inherently time-limited and key-scoped, minimizing abuse potential.
* **Negative:** Requires S3 CORS configuration. Frontend must implement a two-step upload flow. Pre-signed URL generation requires the Worker to hold AWS credentials (mitigated by Cloudflare encrypted secrets).
* **Future Implications:** The same pre-signed URL pattern can be extended for download URLs (GET) if direct S3 reads are needed, keeping the Worker as a thin authorization layer.
