# {{PROJECT_NAME}} — Applications

This directory contains the applications for **{{PROJECT_NAME}}**.

## Structure

Each subdirectory represents a standalone application:

```text
apps/
├── {{APP_NAME}}/
│   ├── README.md          # Application-specific documentation
│   ├── ...                # Application source code
│   └── tests/             # Application tests
└── ...
```

## Conventions

- Each application lives in its own subdirectory
- Every application must have a `README.md` explaining its purpose, setup, and
  usage
- Follow the [Development Philosophy](../meta/DEVELOPMENT_PHILOSOPHY.md) for
  code quality standards
- Include tests alongside the application code
