# Contributing to {{PROJECT_NAME}}

First off, thank you for your interest in {{PROJECT_NAME}}! We're excited
you're here.

This project is currently in a very early and experimental stage. The primary
goal is to use it as a personal learning ground to explore AI-driven software
development and build skills.

That said, collaboration is welcome, even if the process looks a little
different for now.

## Our Current Development Workflow

{{PROJECT_NAME}} follows a specific, AI-assisted workflow:

1. An **Issue** is created that clearly defines a bug or a feature.
2. An **AI assistant** (like GitHub Copilot) is used to generate the code to
   address the issue. This results in a **Pull Request**.
3. The PR is then reviewed, tested, and **merged by a human maintainer**.

This unique process is the core of the experiment.

## How You Can Help Right Now

While external code contributions are not actively sought at this time, there
are several incredibly valuable ways you can contribute:

### 🐛 Report Bugs or Suggest Features

This is the most helpful way to contribute. If you find a bug, have an idea for
a feature, or think something could be improved, please
**[open an issue](https://github.com/{{GITHUB_OWNER}}/{{PROJECT_NAME}}/issues)**!
Clear issues are the starting point for the entire AI workflow.

### 💬 Provide Feedback

Have thoughts on the project's direction, architecture, or even the AI-driven
process itself? Feel free to open an issue to start a discussion.

### 📖 Improve Documentation

If you find a typo, something unclear in the `README` or other documents, or
have a question that could be answered in the docs, please let us know by
opening an issue.

## What About Code Contributions?

For now, code generation and merging are handled through the AI-assisted
workflow described above. This helps maintain a consistent "voice" in the code
and focus on the AI-centric process.

As the project matures, this process will likely evolve. Thank you for your
understanding!

## Code Quality Standards

Before committing any code:

1. **Run all checks:**

   ```bash
   # Use the local CI check script
   ./scripts/local-ci-check.sh
   ```

2. **Follow the patterns:**
   - Write clear, readable code
   - Add documentation for public interfaces
   - Write tests for new functionality
   - Keep changes small and focused

3. **Commit hygiene:**
   - Write descriptive commit messages using conventional commit format
   - Each commit should represent a single logical change
   - Reference related issues in commit messages

## Code of Conduct

All participants are expected to follow our
[Code of Conduct](https://github.com/{{GITHUB_OWNER}}/{{PROJECT_NAME}}/blob/main/CODE_OF_CONDUCT.md).
Please be respectful and considerate in all your interactions.
