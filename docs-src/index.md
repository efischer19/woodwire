# {{PROJECT_NAME}} Documentation

Welcome to the official documentation for **{{PROJECT_NAME}}**.

## Overview

{{PROJECT_NAME}} is a static frontend application built on top of the
[static-js-app-blueprint](https://github.com/efischer19/static-js-app-blueprint)
template, which provides a foundation for HTML/CSS/JavaScript projects with
documentation, architecture decision records, and developer tooling.

## Getting Started

1. **Open `src/index.html`** in a browser to see the starter page.
2. **Edit files in `src/`** — Modify `index.html`, `assets/styles.css`, and
   `scripts/app.js` to build your application.

## Project Structure

```text
{{PROJECT_NAME}}/
├── src/              # Frontend source files
│   ├── index.html    # Entry point with semantic HTML
│   ├── assets/
│   │   ├── styles.css    # Stylesheet with CSS custom properties
│   │   └── favicon.svg   # Placeholder favicon
│   ├── scripts/
│   │   └── app.js        # JavaScript entry point
│   └── README.md         # Documents src/ structure and conventions
├── meta/             # Development philosophy, ADRs, and plans
├── docs-src/         # Documentation source files (MkDocs)
├── scripts/          # Utility and automation scripts
└── .github/          # GitHub-specific configuration
```

## Development Philosophy

All work in this project follows the
[Development Philosophy](DEVELOPMENT_PHILOSOPHY.md), which emphasizes:

- **Code is for Humans First** — Clarity over cleverness
- **Favor Simplicity** — Static-first design with minimal complexity
- **Confidence Through Testing** — Comprehensive automated tests
- **Clean Commit History** — Atomic commits with descriptive messages

## Contributing

For information on contributing to this project, see the
[Contributing Guidelines](CONTRIBUTING.md).

## Getting Help

- Check the documentation pages listed in the navigation
- Review the [Architecture Decision Records](https://github.com/{{GITHUB_OWNER}}/{{PROJECT_NAME}}/tree/main/meta/adr)
  for context on past decisions
- [Open an issue](https://github.com/{{GITHUB_OWNER}}/{{PROJECT_NAME}}/issues)
  if you find a bug or want to suggest a feature
