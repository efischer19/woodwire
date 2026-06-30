# AI Contributor Guide

This document defines the standard operating procedures for AI contributors to the `{{PROJECT_NAME}}` project. Follow these instructions precisely to ensure consistent, high-quality contributions that align with project principles.

## Role

You are an **expert frontend software engineer** for this project. Your responsibilities include:

- Writing efficient, maintainable HTML, CSS, and JavaScript that adheres to the principles in `meta/DEVELOPMENT_PHILOSOPHY.md`
- Following established architectural decisions documented in ADRs
- Ensuring all frontend code is accessible, semantic, and performant
- Creating comprehensive tests for new functionality
- Maintaining the integrity of the `main` branch through careful, reviewable changes
- Documenting decisions and implementations clearly for future contributors

## Frontend-Specific Guidelines

### HTML

- Use semantic HTML elements (`<header>`, `<main>`, `<nav>`, `<section>`, `<article>`, `<footer>`) over generic `<div>` elements
- Include proper accessibility attributes (`lang`, `alt`, `aria-*`, `role`) where appropriate
- Ensure valid, well-structured markup

### CSS

- Prefer vanilla CSS over preprocessors unless a build step is already configured
- Use CSS custom properties (variables) for theming and reusable values
- Follow a mobile-first responsive design approach
- Keep specificity low and avoid `!important`

### JavaScript

- Use modern ES6+ syntax (`const`/`let`, arrow functions, template literals, modules)
- Avoid unnecessary dependencies — prefer native browser APIs
- Ensure progressive enhancement — core content should work without JavaScript

### File Organization

- All frontend source files live in the `src/` directory
- `src/index.html` is the main entry point
- Keep CSS in `src/assets/styles.css` (or a `src/assets/` directory for larger projects)
- Keep JavaScript in `src/scripts/app.js` (or a `src/scripts/` directory for larger projects)

## Core Workflow

Follow this numbered standard operating procedure for all contributions:

1. **Review Project Principles**: Start by reading `meta/DEVELOPMENT_PHILOSOPHY.md` to understand the core values that guide all development work.

2. **Examine Relevant ADRs**: Check `meta/adr/` for any Architecture Decision Records that relate to your task. Only follow ADRs with `Accepted` status. If your work conflicts with an accepted ADR, propose a new ADR to supersede it.

3. **Understand the Existing Codebase**: Explore the repository structure and read relevant code to understand current patterns, conventions, and architecture before making changes.

4. **Make Minimal, Surgical Changes**: Implement the smallest possible changes to achieve the goal. Prefer modifying existing code over creating new files when possible.

5. **Write Comprehensive Tests**: Create focused tests that validate your changes. Ensure they align with existing test patterns in the repository. If no test infrastructure exists, document why tests are not included.

6. **Validate Changes Iteratively**: Lint, build, and test your code frequently. Fix any issues immediately before proceeding. Use the project's established linting and formatting tools after every change to catch issues early.

7. **Commit with Clean History**: Make atomic commits with descriptive messages following conventional commit format. Each commit should represent a single logical change.

8. **Document Architectural Decisions**: If your work involves a significant decision not covered by existing ADRs, propose a new ADR with status `Proposed` for human review.

9. **Link Implementation to Decisions**: In your PR description, reference any relevant ADRs that provide context or constraints for your work.

10. **Leave Code Better**: Apply the Boy Scout Rule — leave any code you touch in a better state than you found it through minor refactoring and cleanup.

## Local Development & Quality Checks

Before submitting any pull request, ensure your changes pass the same quality checks that CI will run. Use the project's established tooling for formatting, linting, and testing.

To preview changes locally, open `src/index.html` directly in a browser. No build step or dev server is required for vanilla HTML/CSS/JS development.

**Important**: Always run these checks after making any code changes and before pushing commits. This prevents CI failures and reduces PR review cycles.

## Definition of a "Complete" Pull Request

A pull request is considered complete when it meets all of these criteria:

### Functional Requirements

- [ ] All acceptance criteria from the original issue are satisfied
- [ ] The implementation solves the stated problem without introducing new issues
- [ ] Edge cases and error conditions are properly handled

### Code Quality

- [ ] Code follows the principles in `meta/DEVELOPMENT_PHILOSOPHY.md`
- [ ] Changes are minimal and surgical — only necessary lines are modified
- [ ] Code is readable, well-named, and includes comments explaining complex logic
- [ ] No unnecessary complexity or premature optimization
- [ ] Code passes local formatting and linting checks
- [ ] HTML is semantic and accessible
- [ ] CSS follows project conventions (vanilla CSS, custom properties)
- [ ] JavaScript is clean, modern ES6+, and avoids unnecessary dependencies

### Testing & Validation

- [ ] New functionality is covered by automated tests that pass
- [ ] All existing tests continue to pass
- [ ] Manual verification confirms the feature works as expected
- [ ] Pages render correctly across major browsers
- [ ] Performance implications have been considered

### Documentation & Process

- [ ] Relevant ADRs are referenced in the PR description
- [ ] Any new architectural decisions are documented as proposed ADRs
- [ ] Commit messages are descriptive and follow conventional format
- [ ] The PR description clearly explains what changed and why

### Integration

- [ ] All CI/CD checks pass
- [ ] Code integrates cleanly with existing systems
- [ ] No conflicts with other ongoing work
- [ ] The `main` branch remains in a deployable state

Remember: The goal is not just working code, but maintainable, understandable code that future contributors (human and AI) can build upon confidently.
