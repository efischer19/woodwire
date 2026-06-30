# feat: Add Pre-signed URL Generation to Cloudflare Worker

## What do you want to build?

Extend the Cloudflare Worker (built in Ticket 06) with an endpoint that
generates short-lived, scoped pre-signed S3 URLs for media uploads and
downloads. This enables the PWA to upload images, files, and voice memos
directly to S3 without the binary data passing through the Worker, per ADR-003.

## Acceptance Criteria

- [ ] `POST /api/upload-url` accepts `{ "filename": "...", "contentType": "image/png" }` and returns `{ "uploadUrl": "https://...", "key": "attachments/..." }`
- [ ] The pre-signed PUT URL expires in 5 minutes
- [ ] The pre-signed URL is scoped to a single, server-generated S3 key under the `attachments/` prefix — the client cannot control the key path
- [ ] The S3 key includes a unique identifier (UUID or timestamp) to prevent collisions
- [ ] Content-Type is enforced in the pre-signed URL conditions to prevent content-type spoofing
- [ ] `GET /api/response/:id` returns a pre-signed GET URL for downloading the AI's response (if it includes binary attachments in `outbox/`)
- [ ] Pre-signed GET URLs expire in 15 minutes
- [ ] File size is validated — uploads exceeding 25 MB are rejected at the Worker level before URL generation
- [ ] Unit tests cover URL generation, expiry, content-type enforcement, and size validation
- [ ] The Worker `README.md` API contract documentation is updated with the new endpoint details

## Implementation Notes (Optional)

Use `@aws-sdk/s3-request-presigner` and `@aws-sdk/client-s3` for pre-signed
URL generation. These packages work in the Cloudflare Workers runtime.

**S3 key generation pattern:**

```text
attachments/{conversationId}/{timestamp}-{uuid4}.{extension}
```

This structure allows the lifecycle policy to clean up by prefix and lets the
bot correlate attachments to conversations.

**Security considerations:**

- The client never controls the S3 key — only the filename and content-type
- Content-type validation should allowlist safe MIME types (images, audio,
  text, PDF) and reject executables
- The 5-minute expiry window is short enough to prevent URL sharing/abuse
  but long enough for slow mobile uploads

**Free Tier context:** Pre-signed URL generation happens entirely in the
Worker (no AWS API call for generation itself). The actual PUT/GET to S3 counts
against S3 free tier limits (2,000 PUT, 20,000 GET/month).
