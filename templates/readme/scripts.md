# {{PROJECT_NAME}} — Scripts

This directory contains utility and automation scripts for **{{PROJECT_NAME}}**.

## Structure

```text
scripts/
├── build-docs.sh          # Build documentation site locally
├── local-ci-check.sh      # Run CI quality checks locally
└── ...
```

## Conventions

- Scripts must be executable (`chmod +x`)
- Include a brief comment block at the top of each script explaining its purpose
- Scripts should be idempotent where possible — safe to run multiple times
- Use `set -e` to fail fast on errors
- Follow the [Development Philosophy](../meta/DEVELOPMENT_PHILOSOPHY.md) for
  code quality standards
