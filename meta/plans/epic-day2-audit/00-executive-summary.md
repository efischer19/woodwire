# Day 2 Operations & Resilience Audit — Executive Summary

## Executive Summary

Project Woodwire is structurally sound as a V1 asynchronous AI Gateway. The
architecture — Cloudflare Worker as an edge gateway, SQS as an event buffer
with a dead-letter queue, S3 as a response mailbox, and a local Python bot as
the execution core — is well-reasoned and correctly implements the zero-inbound-port
security posture described in the ADRs. The codebase demonstrates strong
fundamentals: timing-safe authentication, least-privilege IAM policies, idempotent
S3 key-based writes, comprehensive unit tests, graceful shutdown handling, and a
clean separation of concerns across the monorepo. The development philosophy is
clearly documented and consistently followed.

However, the system has critical Day 2 blind spots that will cause silent
failures in production. The most severe gap is **observability**: there are no
CloudWatch alarms on the dead-letter queue, no structured logging in the Python
bot (it uses unstructured text format), and no mechanism for Worker-side errors
to surface to the end user beyond generic HTTP status codes. The SQS message
payloads lack schema versioning, meaning any future media type addition (video,
documents with metadata) risks crashing the bot on unrecognized fields. The
S3 chat bucket does not have an `AbortIncompleteMultipartUpload` lifecycle rule,
allowing orphaned multipart uploads from failed presigned PUT operations to
accumulate indefinitely. The in-memory rate limiter resets on every Worker cold
start, which is documented but has no fallback alerting.

Immediate priorities for technical debt remediation are: **(1)** Add CloudWatch
alarms for the DLQ and bot error metrics to eliminate the largest observability
blind spot. **(2)** Introduce a `schemaVersion` field to SQS message payloads and
implement forward-compatible parsing in the bot. **(3)** Add the
`AbortIncompleteMultipartUpload` lifecycle rule to the S3 bucket template.
**(4)** Switch the bot to structured JSON logging so log aggregation tools can
parse and alert on error patterns. **(5)** Add a `Page Visibility API` guard to
the PWA polling loop so background tabs do not waste polling cycles against the
Worker's rate limit budget.

## Gap Analysis Breakdown

### Pillar 1 — Observability & Blind Spots

- **No DLQ CloudWatch alarm**: `infra/woodwire-chat-queue.yaml` provisions the
  dead-letter queue but does not create any CloudWatch alarm for
  `ApproximateNumberOfMessagesVisible > 0`. Failed messages silently accumulate
  with no notification.
- **Unstructured bot logging**: `bot/main.py:453-464` configures a text-format
  `StreamHandler`. Log lines are human-readable but not machine-parseable. No
  structured fields for `conversationId`, `messageId`, or error classification.
- **Worker errors are opaque**: `worker/src/index.js` catch blocks (lines 150,
  185, 232, 306, 366, 399) swallow all exceptions and return generic error
  bodies (`Bad Gateway`, `Internal Server Error`). The original error is never
  logged or forwarded to an external observability sink.
- **No error surfacing to PWA**: `src/scripts/app.js` displays a generic "try
  again later" message on non-200 responses. The user has no way to know
  whether a message was enqueued but the bot crashed, or whether the Worker
  itself failed.
- **Missing bot health/heartbeat signal**: The bot has no mechanism to report
  that it is alive and polling. If the bot process dies, the system has no way
  to detect this until messages pile up in the DLQ.

### Pillar 2 — Idempotency & State Machine Integrity

- **Visibility timeout race on heavy TTS**: `bot/main.py:172` extends
  visibility to 120 seconds. Voice synthesis via piper + ffmpeg can exceed this
  on slow hardware (Raspberry Pi). If it does, SQS re-delivers the message
  while the bot is still writing the response, causing a duplicate S3 write to
  the same `outbox/{conversationId}/` prefix. The response key includes a
  Unix timestamp (`int(self.now().timestamp())`), which has only one-second
  granularity — a retry within the same second overwrites the original.
- **No `AbortIncompleteMultipartUpload` lifecycle rule**:
  `infra/woodwire-chat-bucket.yaml` has expiration rules for `inbox/`,
  `outbox/`, and `attachments/` prefixes but does not abort incomplete
  multipart uploads. Failed presigned PUTs from the PWA leave orphaned parts
  that never expire.
- **PWA polling continues in background tabs**: `src/scripts/app.js` uses
  `setTimeout` for the poll loop but does not check `document.hidden` (Page
  Visibility API). When the tab is backgrounded, browsers throttle timers to
  ~1-minute intervals, causing delayed response detection and wasted rate limit
  budget when the tab is foregrounded in bursts.
- **Processing marker is never cleaned up on failure**: `bot/main.py:234-242`
  writes `outbox/{conversationId}/processing.json` at the start of processing.
  If processing throws an exception (line 157-158), the marker remains in S3.
  The Worker's `describeResponseFiles` function treats the presence of
  `processing.json` as "processing" status indefinitely, even after the message
  routes to the DLQ and will never complete.

### Pillar 3 — Schema Evolution & Payload Contracts

- **No schema version in SQS messages**: `worker/src/index.js:165-170`
  constructs the SQS payload with `conversationId`, `text`, `attachments`, and
  `createdAt` but no `schemaVersion` field. The bot's `parse_message_body`
  (`bot/main.py:381-387`) does basic JSON-object validation but has no
  version-aware parsing. Adding a new field (e.g., `mediaType: "video"`) would
  be silently ignored by the bot rather than explicitly handled or rejected.
- **No payload size guard on SQS message body**: The Worker does not enforce a
  maximum message body size before calling `SendMessageCommand`. SQS has a
  256 KB limit; a crafted request with a very large `text` field or many
  attachment keys could cause an unhandled SQS error.
- **Bot does not validate `createdAt` or reject unknown fields**: The bot
  reads only `conversationId`, `text`, and `attachments` from the payload.
  Unknown fields pass through silently. There is no staleness check on
  `createdAt` — a message stuck in the queue for days is processed identically
  to a fresh one.

### Pillar 4 — CI/CD & Artifact Determinism

- **No Worker tests in CI**: `.github/workflows/ci.yml` runs pre-commit,
  markdown lint, HTML lint, and ADR status checks but does not run
  `cd worker && npm test`. Worker regressions are only caught by
  `deploy-worker.yml` at deploy time.
- **No bot tests in CI**: `.github/workflows/ci.yml` does not run
  `python -m unittest discover -s bot/tests`. Bot regressions are only caught
  locally.
- **Frontend deploy leaks no secrets but lacks cache-busting**: The
  `deploy-aws.yml` workflow syncs `src/` to S3 with a flat 1-hour
  `Cache-Control` header. There is no content-hash-based cache-busting for
  `app.js` or `styles.css`, meaning users may run stale JavaScript after a
  deployment until the cache expires.
- **Infrastructure templates are not validated in CI**: The CloudFormation
  templates in `infra/` are not linted or validated
  (`aws cloudformation validate-template`) in any CI workflow. A YAML syntax
  error would only be caught during manual deployment.

## Ticket Sequence

| # | Ticket | Priority | Pillar |
| :--- | :--- | :--- | :--- |
| 01 | Add CloudWatch alarm for SQS dead-letter queue | Critical | Observability |
| 02 | Add Worker and bot test jobs to CI pipeline | Critical | CI/CD |
| 03 | Add `schemaVersion` to SQS message payload contract | High | Schema |
| 04 | Add `AbortIncompleteMultipartUpload` lifecycle rule to S3 bucket | High | Idempotency |
| 05 | Switch bot logging to structured JSON format | High | Observability |
| 06 | Guard PWA polling with Page Visibility API | Medium | Idempotency |
| 07 | Clean up stale processing markers on DLQ routing | Medium | Idempotency |
| 08 | Add SQS message body size validation to Worker | Medium | Schema |
| 09 | Add CloudFormation template validation to CI | Low | CI/CD |
