# {{PROJECT_NAME}} — Libraries

This directory contains shared libraries for **{{PROJECT_NAME}}**.

## Structure

Each subdirectory represents a reusable library:

```text
libs/
├── {{LIB_NAME}}/
│   ├── README.md          # Library-specific documentation
│   ├── ...                # Library source code
│   └── tests/             # Library tests
└── ...
```

## Conventions

- Each library lives in its own subdirectory
- Every library must have a `README.md` documenting its public API, usage
  examples, and any dependencies
- Libraries should be independently testable
- Follow the [Development Philosophy](../meta/DEVELOPMENT_PHILOSOPHY.md) for
  code quality standards
- Keep libraries focused — one responsibility per library
