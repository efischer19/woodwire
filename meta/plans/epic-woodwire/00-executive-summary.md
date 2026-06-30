# Project Woodwire — Epic Ticket Plan: Executive Summary

## Vision

Project Woodwire is an asynchronous, event-driven pipeline that establishes a
secure, private, multimodal communication channel between a user and a local AI
agent. Built entirely on Cloudflare and AWS serverless free-tier infrastructure,
it eliminates the need for traditional WebSockets or active server hosting while
maintaining a zero-inbound-port security posture.

## Architecture Overview

```text
[ Static PWA ]  ──────►  [ Cloudflare Worker ]  ──────►  [ AWS SQS Queue ]
  (S3/CloudFront)          · Passphrase auth               · Event buffer
                           · AWS secret injection           · Long-poll delivery
                           · Pre-signed URL gen                    │
                                                                   ▼
[ Private S3 ]  ◄────────  [ PWA polls Worker ]           [ Local Bot ]
  · outbox/ (AI replies)     for response status            · Outbound-only
  · attachments/                                            · OpenClaw/Ollama
```

## Guiding Constraints

| Constraint | Enforcement |
| :--- | :--- |
| **Zero cost** | All services within AWS Free Tier + Cloudflare free plan |
| **Zero inbound ports** | Bot initiates outbound SQS long-poll only |
| **Stateless PWA** | No credentials in frontend; Worker mediates all access |
| **Resilient under latency** | SQS buffers messages; PWA tolerates async responses |
| **Open-source friendly** | All secrets are externalized; config is environment-based |

## ADRs Proposed in This Epic

| ADR | Decision |
| :--- | :--- |
| ADR-002 | SQS Long Polling over WebSockets |
| ADR-003 | Direct-to-S3 Pre-signed Uploads for media |
| ADR-004 | SQS Visibility Timeout before message deletion |
| ADR-005 | Poll Cloudflare Worker for responses, not S3 directly |
| ADR-006 | Monorepo for PWA, bot, and Worker |

## Ticket Sequence

Tickets are ordered by dependency. Each ticket is independently completable and
produces a verifiable deliverable.

### Phase 0 — Project Housekeeping

| # | Ticket | Deliverable |
| :--- | :--- | :--- |
| 01 | Rewrite README and replace template placeholders | Updated README.md, DEVELOPMENT_PHILOSOPHY.md, ROBOT_ETHICS.md |
| 02 | Configure CI for Woodwire deployment | Updated deploy-aws.yml with push trigger, documented secrets |

### Phase 1 — AWS Infrastructure

| # | Ticket | Deliverable |
| :--- | :--- | :--- |
| 03 | Provision S3 chat bucket with lifecycle policies | IaC template for S3 bucket |
| 04 | Provision SQS queue with dead-letter queue | IaC template for SQS |
| 05 | Create least-privilege IAM policies | IaC template for IAM roles/policies |

### Phase 2 — Edge Security

| # | Ticket | Deliverable |
| :--- | :--- | :--- |
| 06 | Implement Cloudflare Worker — auth and SQS forwarding | Worker source + wrangler config |
| 07 | Add pre-signed URL generation to Cloudflare Worker | Worker endpoint for upload/download URLs |

### Phase 3 — Local Bot

| # | Ticket | Deliverable |
| :--- | :--- | :--- |
| 08 | Build SQS consumer loop with visibility timeout handling | Python bot with long-poll loop |
| 09 | Integrate text processing pipeline (OpenClaw → S3 outbox) | End-to-end text message flow |

### Phase 4 — PWA Frontend

| # | Ticket | Deliverable |
| :--- | :--- | :--- |
| 10 | Build chat interface shell (PWA scaffold) | Semantic HTML/CSS/JS chat UI with PWA manifest |
| 11 | Integrate PWA with Cloudflare Worker (send + poll) | Working text chat flow |
| 12 | Add media upload via pre-signed URLs | Image/file upload from PWA to S3 |

### Phase 5 — Voice Memos

| # | Ticket | Deliverable |
| :--- | :--- | :--- |
| 13 | Add voice memo recording to PWA | Web Audio API recording + upload |
| 14 | Build voice processing pipeline in local bot | STT → AI → TTS pipeline |
| 15 | Add voice memo playback to PWA | Audio player + transcript display |

## Free Tier Budget Analysis

| Service | Free Tier Allowance | Expected Usage | Margin |
| :--- | :--- | :--- | :--- |
| SQS | 1M requests/month | ~50K (generous estimate) | 95% headroom |
| S3 Storage | 5 GB | < 1 GB (48h lifecycle) | 80% headroom |
| S3 PUT/GET | 2K PUT + 20K GET/month | ~5K GET (via Worker cache) | 75% headroom |
| CloudFront | 1 TB transfer/month (12 mo) | < 1 GB | 99% headroom |
| Cloudflare Workers | 100K requests/day | < 1K/day | 99% headroom |

## Persona Review

### SecurityOps

> "The zero-inbound-port posture is strong. I want to see explicit CORS
> lockdown on S3, CSP headers on the PWA, pre-signed URL expiry under 5
> minutes, and the passphrase mechanism documented with a rotation path.
> The IAM ticket must include an explicit deny-all default policy."

**Adjustments incorporated:** Ticket 05 (IAM) requires explicit deny-all
baseline. Ticket 06 (Worker) mandates CORS and CSP headers. Ticket 07
(pre-signed URLs) specifies 5-minute expiry. Passphrase rotation is documented
in Ticket 06 implementation notes.

### FinancialOps

> "The free tier budget table is good but I need alerting. Add a CloudWatch
> billing alarm at $1.00 to catch any accidental overages. Every ticket that
> touches AWS must include the free tier limit it operates within."

**Adjustments incorporated:** Ticket 03 (S3) and Ticket 04 (SQS) include free
tier limits in implementation notes. Ticket 05 (IAM) includes a billing alarm
requirement. Every AWS-touching ticket references its free tier budget.

### Hacker News Reader / Open-Source Adopter

> "I want to fork this and swap out OpenClaw for my own LLM. The bot's AI
> integration must be pluggable — an interface, not a hard dependency. The
> README must have a clear 'deploy your own' section with a one-command
> infrastructure setup."

**Adjustments incorporated:** Ticket 09 (text processing) specifies an
abstract AI interface that can be swapped. Ticket 01 (README) includes a
deployment guide section. IaC tickets (03–05) produce templates that can be
deployed with a single command.

### Off-the-Grid Power User

> "I'm running this on a Raspberry Pi over a cellular hotspot. The bot must
> handle intermittent connectivity gracefully — reconnect automatically, never
> lose messages. The PWA must work offline and sync when connectivity returns."

**Adjustments incorporated:** Ticket 08 (SQS consumer) requires exponential
backoff reconnection and graceful network error handling. Ticket 10 (PWA shell)
includes service worker for offline capability. SQS's 14-day message retention
inherently handles extended outages.

### Automation Foreman

> "Tickets are well-scoped. Each has clear AC with checkboxes. Dependencies are
> linear and logical — no circular deps. I'd flag that Ticket 11 (PWA ↔ Worker
> integration) is the integration risk point where frontend and backend must
> agree on API contracts. Consider defining the Worker API contract early."

**Adjustments incorporated:** Ticket 06 (Worker) implementation notes include a
requirement to define and document the full API contract (endpoints, request/
response shapes, error codes) so downstream tickets (07, 11, 12, 13) can
implement against a stable interface.
