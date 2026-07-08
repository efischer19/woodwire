---
title: "Record 7: Use uv for Bot Python Dependency Management"
status: "Proposed"
date: "2026-07-08"
tags:
  - "bot"
  - "dependency-management"
  - "python"
  - "ci-cd"
---

## Context

* **Problem:** The bot's Python dependencies were previously managed using standard `pip` with a `requirements.txt` file. This approach lacks deterministic builds, version locking, and performance for dependency resolution. As the project grows, a modern dependency management solution becomes increasingly important for maintainability and reproducibility.

* **Constraints:** The bot must maintain compatibility with Python 3.11+, support optional voice processing features (faster-whisper, piper), and cleanly handle fallback to text-only modes when optional system dependencies (ffmpeg) are missing. The migration must not break existing CI/CD workflows or development workflows.

## Decision

The bot's Python environment will be managed using `uv` (an ultra-fast Python package installer and resolver, written in Rust). All dependencies will be specified in a `pyproject.toml` file in the `bot/` directory, with version constraints derived from the existing `requirements.txt`. An automatically-generated `uv.lock` file will ensure deterministic, reproducible builds.

## Considered Options

1. **uv (The Chosen One):** Fast, deterministic Python dependency management with a `pyproject.toml` and generated lockfile.
    * *Pros:*
      - Deterministic builds with explicit lockfile (`uv.lock`) that ensures reproducibility across environments
      - Dramatically faster dependency resolution and installation compared to pip
      - Modern tooling aligned with Python packaging best practices
      - Single, unified approach to dependency management for all Python sub-projects
      - Excellent support for optional dependencies and workspace-like configurations
      - Native support for Python version constraints at the project level
    * *Cons:*
      - Requires developers and CI to install and use a new tool
      - Slight learning curve for developers not familiar with modern Python packaging
      - Still relatively newer in the ecosystem compared to pip, though rapidly gaining adoption

2. **Poetry:** A popular Python dependency management tool with built-in build system.
    * *Pros:*
      - Well-established and mature
      - Rich feature set for package publishing
    * *Cons:*
      - Slower dependency resolution
      - More opinionated and potentially restrictive for our use case
      - Larger footprint and more dependencies

3. **pip + Constraints Files:** Extend the current approach with PEP 440 constraint files for better reproducibility.
    * *Pros:*
      - No new tooling required
      - Minimal migration effort
    * *Cons:*
      - Constraint files are not as powerful or widely adopted as lockfiles
      - Still slower than modern alternatives
      - Does not modernize the development workflow

## Consequences

* **Positive:**
  - **Deterministic Builds:** The `uv.lock` file guarantees that all developers and CI systems use the exact same dependency versions, eliminating "works on my machine" issues.
  - **Faster Workflows:** `uv` is orders of magnitude faster than pip, improving both development and CI cycle times.
  - **Modern Dependency Declaration:** Using `pyproject.toml` aligns the bot with current Python packaging standards (PEP 518, PEP 621), making the project more accessible to new contributors familiar with modern Python tooling.
  - **Better Optional Dependency Handling:** The bot's optional voice processing features (faster-whisper, piper) are now explicitly declared and can be installed with `uv sync --extras voice`.
  - **Cleaner CI/CD:** The bot's CI test job is simplified to `uv sync` followed by standard test commands, making the workflow more readable and maintainable.
  - **Future-Proof:** `uv` is backed by Astral (the creators of Ruff) and has strong momentum in the Python community.

* **Negative:**
  - **New Dependency:** Developers must install `uv`. However, it is a single, standalone binary that is trivial to install.
  - **Transition Effort:** CI workflows and README documentation must be updated to reflect the new workflow.
  - **Path Configuration:** Tests and bot execution require PYTHONPATH configuration because the bot is a package located in a subdirectory.

* **Future Implications:**
  - If additional Python sub-projects are added to the repository, they should also consider using `uv` for consistency.
  - The `uv.lock` file should be committed to version control to enable deterministic builds for CI and reproducible local development.
  - The bot's `requirements.txt` can be deprecated; all dependency information is now centralized in `pyproject.toml`.
  - Future bot dependency updates will be easier to track and audit via lockfile changes.

