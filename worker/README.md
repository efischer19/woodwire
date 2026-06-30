# Woodwire Cloudflare Worker

This Worker is Woodwire's zero-trust edge gateway. It authenticates requests
with `X-Woodwire-Auth`, forwards inbound messages to SQS, polls S3 for outbox
status, and defines the API contract that the PWA and bot integrate against.

## Deployment Configuration

Set the required secrets and variables before running `wrangler deploy`.

### Worker secrets

```bash
cd worker
wrangler secret put WOODWIRE_AUTH
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY
# Optional when using temporary credentials:
wrangler secret put AWS_SESSION_TOKEN
```

### Worker variables

Configure these in `wrangler.toml`, via `wrangler deploy --var`, or in the
Cloudflare dashboard:

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `AWS_REGION` | No | `us-east-1` | AWS region for SQS and S3 calls |
| `CHAT_QUEUE_URL` | Yes | — | SQS queue URL that receives inbound chat messages |
| `CHAT_BUCKET_NAME` | Yes | — | S3 bucket that stores `outbox/` response objects |
| `PWA_ORIGIN` | Yes | — | Exact frontend origin allowed by CORS |
| `RATE_LIMIT_REQUESTS` | No | `30` | Maximum requests per window per source IP |
| `RATE_LIMIT_WINDOW_SECONDS` | No | `60` | Sliding-window duration for rate limiting |
| `STATUS_CACHE_TTL_SECONDS` | No | `3` | Edge cache TTL for `/api/status/:id` (clamped to 2–5 seconds) |

## Authentication

All `/api/*` endpoints except `GET /api/health` require the
`X-Woodwire-Auth` header. The header value must exactly match the Worker secret
stored as `WOODWIRE_AUTH`.

Example:

```http
X-Woodwire-Auth: your-shared-passphrase
```

Requests with a missing or incorrect passphrase receive:

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8

{"error":"Unauthorized"}
```

### Passphrase rotation

Rotate the passphrase with no downtime by updating the Worker secret:

```bash
cd worker
wrangler secret put WOODWIRE_AUTH
```

After rotation, update the PWA's stored passphrase to the new value.

## Security Model

Every response includes these hardening headers:

```text
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

Browser requests are only accepted from the configured `PWA_ORIGIN`. Requests
from any other `Origin` receive `403 Forbidden`.

The default free-tier rate limiter allows 30 requests per 60-second sliding
window per source IP. The implementation is in-memory, so counters reset on
Worker cold starts or when requests land on different isolates.

## API Contract

### `GET /api/health`

Health check. This is the only unauthenticated endpoint.

#### Response

```json
{
  "status": "ok"
}
```

### `POST /api/message`

Queues a new chat request for the local bot.

**Auth:** Required

#### Request body

```json
{
  "text": "Hello from the PWA",
  "attachments": [
    "attachments/conversation-123/voice-note.m4a"
  ]
}
```

- `text` must be a non-empty string
- `attachments` must be an array of non-empty string keys

#### Success response

```http
HTTP/1.1 202 Accepted
```

```json
{
  "conversationId": "9f4fd2aa-6f7d-4e3a-9564-c6470cbaad37",
  "status": "pending"
}
```

#### SQS message shape

```json
{
  "conversationId": "9f4fd2aa-6f7d-4e3a-9564-c6470cbaad37",
  "createdAt": "2026-06-30T12:00:00.000Z",
  "text": "Hello from the PWA",
  "attachments": [
    "attachments/conversation-123/voice-note.m4a"
  ]
}
```

### `POST /api/upload-url`

Reserves a pre-signed S3 upload URL for an attachment.

**Auth:** Required

#### Request body

```json
{
  "filename": "photo.png",
  "contentType": "image/png",
  "sizeBytes": 1048576
}
```

`sizeBytes` is optional but recommended so the Worker can reject uploads larger
than 25 MB before issuing a URL. If `sizeBytes` is omitted, the Worker still
validates the filename and `contentType` but cannot perform the 25 MB preflight
size check. Allowed MIME types are `image/*`, `audio/*`, `text/*`, and
`application/pdf`.

#### Success response

```json
{
  "uploadUrl": "https://example-presigned-url",
  "key": "attachments/conversation-123/1719758400-uuid4.png"
}
```

The returned `uploadUrl` is a single-use-style pre-signed `PUT` URL for the
exact `key` above. It expires in 5 minutes, and the signed request binds the
object to the server-generated S3 key plus the declared `Content-Type`.

### `GET /api/status/:conversationId`

Polls for the current bot response state by listing `outbox/:conversationId/`
objects in S3. Results are cached at the Cloudflare edge for 2–5 seconds per
[ADR-005](../meta/adr/ADR-005-edge_polling_mitigation.md).

**Auth:** Required

#### Response

```json
{
  "conversationId": "9f4fd2aa-6f7d-4e3a-9564-c6470cbaad37",
  "status": "pending",
  "hasAudio": false,
  "hasTranscript": false,
  "cacheTtlSeconds": 3
}
```

Possible `status` values:

- `pending`: No `outbox/{conversationId}/` objects exist yet
- `processing`: The bot has created `outbox/{conversationId}/processing.json`
- `complete`: Any non-marker object exists under `outbox/{conversationId}/`

### `GET /api/response/:conversationId`

Returns response content or a pre-signed download URL for bot output.

**Auth:** Required

#### Success response

```json
{
  "transcript": "AI response text here...",
  "audioUrl": "https://example-presigned-url"
}
```

The Worker lists `outbox/{conversationId}/`, ignores the
`processing.json` marker, reads any `.md` transcript object, and returns a
pre-signed `GET` URL for any `.mp3` audio object it finds. Download URLs
expire in 15 minutes.

## Error Codes

| Status | When it happens | Response body |
| :--- | :--- | :--- |
| `400` | Invalid JSON, invalid field types, or malformed conversation ID | `{"error":"..."}` |
| `401` | Missing or incorrect `X-Woodwire-Auth` header | `{"error":"Unauthorized"}` |
| `403` | Browser `Origin` does not match `PWA_ORIGIN` | `{"error":"Forbidden"}` |
| `404` | Unknown endpoint | `{"error":"Not Found"}` |
| `405` | Unsupported HTTP method | `{"error":"Method Not Allowed"}` |
| `413` | Requested attachment exceeds the 25 MB Worker upload limit | `{"error":"Attachments must be 25 MB or smaller"}` |
| `429` | Rate limit exceeded for the source IP | `{"error":"Too Many Requests"}` |
| `500` | Required Worker configuration is missing | `{"error":"Internal Server Error"}` |
| `502` | AWS SQS or S3 call failed | `{"error":"Bad Gateway"}` |

## Local Commands

```bash
cd worker
npm test
npx wrangler deploy --dry-run
```
