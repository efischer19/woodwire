---
title: "ADR-006: Keep PWA Frontend and Local Bot in a Single Repository"
status: "Accepted"
date: "2026-06-30"
tags:
  - "architecture"
  - "repository"
  - "ci-cd"
---

## Context

* **Problem:** Woodwire has two primary deployable artifacts: (1) a static PWA frontend deployed to S3/CloudFront and (2) a Python-based local bot that runs on the user's machine. These artifacts have different deployment targets, different languages, and different runtime environments. The question is whether they should live in one repository or be split across multiple.
* **Constraints:** The project is maintained by a single developer with AI assistance. Complexity of multi-repo coordination (cross-repo issues, synchronized releases, shared documentation) must be weighed against the clarity of separation.

## Decision

Both the PWA frontend and the local bot will live in this **single repository** (`woodwire`), organized as a monorepo with clear directory boundaries:

```text
woodwire/
├── src/              # PWA frontend (HTML/CSS/JS) — deploys to S3
├── bot/              # Local Python bot — runs on user's machine
├── worker/           # Cloudflare Worker source — deploys to Cloudflare
├── infra/            # IaC templates (CloudFormation/Terraform)
├── meta/             # ADRs, plans, philosophy docs
└── .github/workflows # CI/CD for all artifacts
```

## Considered Options

1. **Monorepo (Chosen):** All components in a single repository with path-based CI triggers.
    * *Pros:* Single source of truth for documentation and ADRs. Atomic cross-component changes (e.g., changing an S3 prefix affects both Worker and bot). Simpler issue tracking. Easier for AI agents to understand the full system. One set of CI/CD workflows with path filters.
    * *Cons:* CI must use path filters to avoid unnecessary builds. Repository grows larger over time. Contributors must understand the full project structure.
2. **Multi-repo (frontend + backend):** Separate repos for PWA and bot.
    * *Pros:* Clean separation of concerns. Independent release cycles. Smaller, focused repositories.
    * *Cons:* Cross-repo coordination overhead. Duplicated documentation. Harder to make atomic changes across components. More complex for a single-developer project.
3. **Multi-repo with shared config repo:** Three repos (frontend, bot, shared-config).
    * *Pros:* Maximum separation. Shared configuration is versioned independently.
    * *Cons:* Highest coordination overhead. Overkill for a project of this scale.

## Consequences

* **Positive:** All project context is in one place. AI agents can reason about the full system. Documentation and ADRs apply universally. Issue tracking is centralized.
* **Negative:** CI workflows need path-based triggers to avoid running frontend checks on bot-only changes and vice versa. The repository structure must be clearly documented to prevent confusion.
* **Future Implications:** If the project grows significantly or gains multiple contributors working on different components, this decision can be revisited. Splitting a monorepo is straightforward; merging split repos is painful. Starting with a monorepo preserves optionality.
