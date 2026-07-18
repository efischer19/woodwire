# Woodwire

> Secure, asynchronous chat between a static web app and a local AI bot.

Woodwire is an event-driven system for private, multimodal communication between a browser-based PWA and a local bot process. The frontend stays static and credential-free, while a Cloudflare Worker and AWS services coordinate message flow.

**[🚀 Quick Start](./QUICK_START.md)** | **[🤖 OpenClaw](https://github.com/openclaw/openclaw)** | **[📚 Architecture](#architecture-overview)** | **[🔗 Docs](#documentation)**

## About the Name

`Woodwire` captures the spirit of this project. I'm the type who would choose build a wood cabin in the mountains — except in this case it's not a cabin, it's a "wooden" telephone line to my local AI. The name evokes both the analog simplicity of a cabin phone line and the digital connection to an AI that lives on your own machine.

## This is an OpenClaw Channel

While Woodwire supports multiple AI backends (OpenClaw, Ollama, or mock), it's designed with **OpenClaw** as the first-class integration. If you're looking for a secure, locally-hosted chat interface for OpenClaw, Woodwire is built for you.

## Key Features

- **Private & Encrypted** — Messages stay in your control; optional client-side AES-256-GCM encryption
- **Credential-Free Frontend** — Static PWA with no hardcoded secrets; all auth happens at the edge
- **Zero-Trust Gateway** — Cloudflare Worker validates every request with a shared passphrase
- **Multimodal** — Text, images, audio attachments; automatic voice transcription and synthesis
- **Outbound-Only Bot** — Local bot never exposes ports; all communication is pull-based via SQS + S3
- **No Build Required** — Frontend is vanilla HTML/CSS/JS; deploy directly to S3/CloudFront or GitHub Pages
- **Infrastructure as Code** — CloudFormation templates for reproducible AWS deployments

## Architecture Overview

### Message Flow: Inbound Pipeline (Browser → Bot)

```text
┌─────────────────────────────────────────────────────────────────┐
│                    INBOUND PIPELINE                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [ Browser PWA ]  ──► [ Cloudflare Worker ]  ──► [ AWS SQS ]   │
│    (Static)           (Zero-trust auth)         (Event buffer)  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
  1. User sends message from PWA
  2. Worker validates X-Woodwire-Auth header
  3. Message is forwarded to SQS queue
  4. Local bot polls SQS and processes
```

### Message Flow: Outbound Pipeline (Bot → Browser)

```text
┌─────────────────────────────────────────────────────────────────┐
│                    OUTBOUND PIPELINE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [ Local Bot ]  ──► [ Private S3 Bucket ]  ──► [ Browser polls]│
│   (OpenClaw/etc)     (outbox/ responses)       (via Worker)     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
  1. Bot processes inbound message
  2. Bot writes response to S3 outbox/
  3. Browser polls Worker for status
  4. Worker retrieves response from S3 and returns to browser
```

### Repository Structure

Woodwire follows the monorepo layout defined in [ADR-006](./meta/adr/ADR-006-monorepo_structure.md):

```text
woodwire/
├── src/              # PWA frontend (HTML/CSS/JS) → deploys to S3/CloudFront
├── bot/              # Local Python bot (SQS poller, LLM orchestrator)
├── worker/           # Cloudflare Worker source (zero-trust gateway)
├── infra/            # AWS CloudFormation templates (IaC)
├── meta/             # ADRs, design docs, philosophy
└── .github/          # CI/CD workflows
```

## Documentation

Each component has its own detailed documentation:

- **[QUICK_START.md](./QUICK_START.md)** — Setup guide from AWS account to running chat
- **[src/README.md](./src/README.md)** — Frontend architecture, accessibility, conventions
- **[worker/README.md](./worker/README.md)** — Cloudflare Worker API contract, auth, deployment
- **[bot/README.md](./bot/README.md)** — Local bot setup, AI backends, voice support, troubleshooting
- **[infra/README.md](./infra/README.md)** — AWS infrastructure stacks, IAM setup, parameters

## Quick Start

To get up and running:

1. **[Follow the QUICK_START.md](./QUICK_START.md)** for step-by-step AWS, Worker, bot, and PWA setup

2. Or skip to component-specific docs:
   - Setting up AWS? See [infra/README.md](./infra/README.md)
   - Deploying the Worker? See [worker/README.md](./worker/README.md)
   - Running the bot? See [bot/README.md](./bot/README.md)
   - Customizing the frontend? See [src/README.md](./src/README.md)

## Development

### Local Quality Checks

Before committing, run the project's linters and tests:

```bash
# Pre-commit hooks
pip install pre-commit
pre-commit run --all-files

# Markdown linting
npx --yes markdownlint-cli2 "**/*.md"

# HTML linting
npx --yes htmlhint "src/**/*.html"

# Bot unit tests
cd bot
uv sync
python -m unittest discover -s tests -v

# Worker tests
npx --yes vitest run worker/index.test.js
```

### Development Philosophy

Development standards and contributor expectations are documented in [meta/DEVELOPMENT_PHILOSOPHY.md](./meta/DEVELOPMENT_PHILOSOPHY.md). Please read this before contributing.

### Architecture Decisions

This project uses [Architecture Decision Records (ADRs)](./meta/adr/ADR-001-use_adrs.md) to document significant design choices. Before proposing a major change, review existing ADRs in [meta/adr/](./meta/adr/).

## Encryption & Security

### Client-Side E2EE (Schema Version 2)

Optional AES-256-GCM encryption between browser and bot:

```bash
# Generate a 32-byte base64 key
openssl rand -base64 32

# Set on bot
export WOODWIRE_E2EE_KEY=your-base64-key
python bot/main.py

# Set in PWA settings (exact same key)
```

The Cloudflare Worker **intentionally does not** receive this key—it never has the ability to decrypt messages.

### Schema Version 1 (Legacy, Unencrypted)

For backwards compatibility, unencrypted messages continue to work.

## Contributing

This project was built for personal use. While you're welcome to clone, fork, and use it, expect limited maintenance. For bugs, ideas, or questions, feel free to open an issue—but understand that responses may be infrequent.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for more details.

## License

This project is licensed under the [MIT License](./LICENSE.md).

## Resources

- [GitHub OpenClaw](https://github.com/openclaw/openclaw) — Local LLM backend
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [AWS CloudFormation Documentation](https://docs.aws.amazon.com/cloudformation/)
