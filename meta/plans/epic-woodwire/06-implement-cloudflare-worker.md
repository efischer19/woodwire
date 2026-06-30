# feat: Implement Cloudflare Worker — Auth, SQS Forwarding, and API Contract

## What do you want to build?

Build the Cloudflare Worker that serves as Woodwire's zero-trust edge gateway.
The Worker authenticates incoming requests via a passphrase header, injects
AWS credentials (stored as encrypted Worker secrets), forwards text messages to
SQS, and serves as the API contract that all other components (PWA, bot)
implement against.

This is the central integration point — the Worker's API contract must be fully
documented before downstream tickets (07, 11, 12) begin implementation.

## Acceptance Criteria

- [ ] A Cloudflare Worker project is scaffolded in `worker/` with a `wrangler.toml` configuration
- [ ] The Worker validates a custom `X-Woodwire-Auth` header containing a passphrase against an encrypted Worker secret
- [ ] Unauthenticated or incorrectly authenticated requests receive a `401 Unauthorized` response with no information leakage
- [ ] `POST /api/message` accepts a JSON body `{ "text": "...", "attachments": [] }` and enqueues a message to SQS
- [ ] `GET /api/status/:conversationId` returns the current response status (pending, processing, complete) by checking S3 for outbox objects — with edge caching (2–5 second TTL per ADR-005)
- [ ] All responses include strict security headers: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security`
- [ ] CORS headers are set to allow only the Woodwire PWA origin (configurable)
- [ ] Rate limiting is enforced (configurable, default 30 requests/minute per source IP)
- [ ] A `README.md` in `worker/` documents the full API contract: all endpoints, request/response shapes, error codes, and authentication requirements
- [ ] The Worker deploys successfully via `wrangler deploy`
- [ ] All Worker code has unit tests using Cloudflare's Miniflare or Vitest

## Implementation Notes (Optional)

**API Contract (define this first, implement second):**

| Endpoint | Method | Auth | Description |
| :--- | :--- | :--- | :--- |
| `/api/message` | POST | Required | Send a text message to the AI |
| `/api/upload-url` | POST | Required | Get a pre-signed S3 PUT URL (Ticket 07) |
| `/api/status/:id` | GET | Required | Poll for AI response status |
| `/api/response/:id` | GET | Required | Retrieve the AI's response content |
| `/api/health` | GET | None | Health check (returns 200) |

**Passphrase rotation:** Document in the README that the passphrase can be
rotated by updating the Worker secret via `wrangler secret put WOODWIRE_AUTH`
and updating the PWA's stored passphrase. No downtime is required.

**AWS SDK:** Use the `@aws-sdk/client-sqs` npm package (tree-shakeable, works
in Workers). Keep the bundle size minimal — Workers have a 1 MB compressed
limit on the free plan.

**Security headers example:**

```text
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

**Rate limiting:** Use Cloudflare's built-in rate limiting rules if on a paid
plan, or implement a simple in-memory counter per IP with a sliding window for
the free tier. Document the limitation that in-memory rate limiting resets on
Worker cold starts.
