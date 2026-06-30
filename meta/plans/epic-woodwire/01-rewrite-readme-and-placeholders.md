# feat: Rewrite README and Replace Template Placeholders

## What do you want to build?

Replace all template boilerplate from the `static-js-app-blueprint` with
Woodwire-specific content. The repository README, development philosophy, and
robot ethics documents still contain `{{PROJECT_NAME}}` placeholders and
generic descriptions that do not reflect the project's actual purpose.

This ticket establishes the project's public identity and provides the first
thing a contributor or adopter sees when they visit the repo.

## Acceptance Criteria

- [ ] `README.md` is rewritten to describe Project Woodwire — its purpose, architecture overview, and "deploy your own" quickstart guide
- [ ] `README.md` includes a high-level architecture diagram (ASCII or Mermaid) matching the system design in `meta/plans/`
- [ ] `README.md` includes a "Repository Structure" section reflecting the monorepo layout defined in ADR-006
- [ ] All `{{PROJECT_NAME}}` placeholders in `meta/DEVELOPMENT_PHILOSOPHY.md` are replaced with `Woodwire`
- [ ] All `{{PROJECT_NAME}}` and `{{PROJECT_URL}}` placeholders in `meta/ROBOT_ETHICS.md` are replaced with `Woodwire` and the repo URL
- [ ] `meta/plans/README.md` has its `{{PROJECT_NAME}}` placeholder replaced
- [ ] `src/index.html` title and heading are updated from "Static JS App" to "Woodwire" (minimal change — full UI redesign is a later ticket)
- [ ] All linting checks pass (`markdownlint`, `htmlhint`, `pre-commit`)

## Implementation Notes (Optional)

This is a documentation-only ticket with minor HTML changes. No new
dependencies or infrastructure are required.

The README should include these sections at minimum:

1. Project name and one-line description
2. Architecture overview (link to `meta/plans/` for full details)
3. Repository structure (per ADR-006 monorepo layout)
4. Quickstart / "Deploy Your Own" (can be placeholder headings for now, filled
   in as infrastructure tickets complete)
5. Design principles (link to `meta/DEVELOPMENT_PHILOSOPHY.md`)
6. License

Reference the `.github/copilot-instructions.md` custom instructions for
frontend conventions to follow when editing HTML.
