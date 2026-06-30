#!/usr/bin/env bash
# scripts/local-ci-check.sh
#
# Run the same quality checks locally that CI runs on pull requests.
# This helps catch issues before pushing and waiting for CI feedback.
#
# Prerequisites:
#   pip install pre-commit
#
# Usage:
#   ./scripts/local-ci-check.sh
#
# What this script runs:
#   1. pre-commit hooks (trailing whitespace, end-of-file fixer, YAML/JSON/TOML
#      validation, merge conflict detection, mixed line endings, ADR status check)
#   2. Markdown linting (if markdownlint-cli2 is installed)
#
# To install pre-commit hooks for automatic checking on every commit:
#   pre-commit install

set -euo pipefail

echo "=== Local CI Quality Checks ==="
echo ""

# --- Pre-commit hooks ---
echo "▶ Running pre-commit hooks..."
if command -v pre-commit &> /dev/null; then
  pre-commit run --all-files
  echo "✅ Pre-commit hooks passed"
else
  echo "❌ pre-commit is not installed."
  echo "   Install it with: pip install pre-commit"
  echo "   Then run: pre-commit install"
  exit 1
fi

echo ""

# --- Markdown linting (optional) ---
echo "▶ Running markdown lint..."
if command -v markdownlint-cli2 &> /dev/null; then
  markdownlint-cli2 "**/*.md"
  echo "✅ Markdown lint passed"
elif npx --yes markdownlint-cli2 --help &> /dev/null 2>&1; then
  npx --yes markdownlint-cli2 "**/*.md"
  echo "✅ Markdown lint passed"
else
  echo "⚠️  markdownlint-cli2 is not installed — skipping markdown lint"
  echo "   Install it with: npm install -g markdownlint-cli2"
fi

echo ""
echo "=== All checks passed ✅ ==="
