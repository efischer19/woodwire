#!/bin/bash
set -e

# Build Documentation Script
# Generates the static documentation site using MkDocs

echo "📚 Building {{PROJECT_NAME}} Documentation"
echo "========================================================"

# Change to repository root
cd "$(dirname "$0")/.."

# Check for MkDocs
if ! command -v mkdocs &> /dev/null; then
    echo "❌ Error: mkdocs is not installed."
    echo "   Install with: pip install -r docs-requirements.txt"
    exit 1
fi

# Build the documentation site
echo ""
echo "🏗️  Building documentation site..."
mkdocs build

echo "✅ Documentation site built successfully"
echo ""
echo "📂 Documentation files are in: ./site/"
echo "🌐 To serve locally, run: mkdocs serve"
echo "🚀 Documentation ready for deployment!"
