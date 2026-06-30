# Woodwire

> Secure, asynchronous chat between a static web app and a local AI bot.

Woodwire is an event-driven system for private, multimodal communication between a browser-based PWA and a local bot process. The frontend stays static and credential-free, while a Cloudflare Worker and AWS services coordinate message flow.

## Architecture Overview

For full implementation details, see [`/meta/plans/`](./meta/plans/), especially the [epic executive summary](./meta/plans/epic-woodwire/00-executive-summary.md).

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

## Repository Structure

Woodwire follows the monorepo layout defined in [ADR-006](./meta/adr/ADR-006-monorepo_structure.md):

```text
woodwire/
├── src/              # PWA frontend (HTML/CSS/JS) — deploys to S3
├── bot/              # Local Python bot — runs on user's machine
├── worker/           # Cloudflare Worker source — deploys to Cloudflare
├── infra/            # IaC templates (CloudFormation/Terraform)
├── meta/             # ADRs, plans, philosophy docs
└── .github/workflows # CI/CD for all artifacts
```

## Deploy Your Own (Quickstart)

> This section will be expanded as infrastructure tickets land. Use the plan docs as the source of truth in the meantime.

1. Review architecture and sequencing in [`meta/plans/epic-woodwire/`](./meta/plans/epic-woodwire/).
2. Provision AWS resources (S3, SQS, IAM) from the infra tickets.
3. Deploy the Cloudflare Worker with passphrase auth and SQS forwarding.
4. Run the local bot and point it at your queue and storage config.
5. Deploy `src/` as the static PWA frontend.

### Local Quality Checks

```bash
pip install pre-commit
pre-commit run --all-files
npx --yes markdownlint-cli2 "**/*.md"
npx --yes htmlhint "src/**/*.html"
```

## Design Principles

Development standards and contributor expectations are documented in [`meta/DEVELOPMENT_PHILOSOPHY.md`](./meta/DEVELOPMENT_PHILOSOPHY.md).

## License

This project is licensed under the [MIT License](./LICENSE.md).
