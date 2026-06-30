# static-js-app-blueprint

> A template repository for building static frontend applications with HTML, CSS, and JavaScript.

## What Is This?

This is a **GitHub template repository** that provides the foundational directory structure, documentation, and configuration for static frontend web applications. It is framework-agnostic — the default example uses vanilla HTML/CSS/JS, but the structure accommodates any static build output (React, Vue, Svelte, etc.).

This template is derived from the [blueprint-repo-blueprints](https://github.com/efischer19/blueprint-repo-blueprints) grandparent template, which provides universal scaffolding for documentation, ADRs, and developer tooling.

## How to Use This Template

1. Click the **"Use this template"** button at the top of the repository page on GitHub.
2. Choose a name for your new repository.
3. Clone your new repository and begin building your frontend application in the `src/` directory.

For more details on GitHub template repositories, see the [official documentation](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository).

## What's Included

| Path | Purpose |
| :--- | :--- |
| `src/` | Frontend source files — `index.html`, `assets/`, `scripts/` |
| `meta/adr/` | Architecture Decision Records — the logbook of *why* decisions were made |
| `meta/plans/` | Project plans and roadmaps |
| `docs-src/` | Source files for generated documentation (e.g., MkDocs) |
| `scripts/` | Utility and automation scripts |
| `.github/` | GitHub-specific configuration (issue templates, PR templates, Copilot instructions) |

### Key Files

- **`src/index.html`** — Starter page with semantic HTML and accessibility best practices
- **`src/assets/styles.css`** — Responsive stylesheet with CSS custom properties and dark mode
- **`src/scripts/app.js`** — JavaScript entry point with accessible theme toggle
- **`src/assets/favicon.svg`** — Placeholder favicon
- **`src/README.md`** — Documents the `src/` file structure and conventions
- **`LICENSE.md`** — MIT License
- **`CODE_OF_CONDUCT.md`** — Contributor Covenant Code of Conduct
- **`SECURITY.md`** — Security policy and vulnerability reporting
- **`CONTRIBUTING.md`** — Guidelines for contributing to the project
- **`meta/adr/TEMPLATE.md`** — Template for new Architecture Decision Records
- **`meta/adr/ADR-001-use_adrs.md`** — The founding ADR: use ADRs to document decisions

## Getting Started

After creating a new repository from this template:

### 1. Replace Template Placeholders

Search the repository for the following placeholders and replace them with values appropriate for your project:

| Placeholder | Description | Example |
| :--- | :--- | :--- |
| `{{PROJECT_NAME}}` | Your repository / project name | `my-awesome-project` |
| `{{GITHUB_OWNER}}` | GitHub username or organization | `my-org` |
| `{{APP_NAME}}` | Application directory name (in `templates/readme/apps.md`) | `web-app` |
| `{{LIB_NAME}}` | Library directory name (in `templates/readme/libs.md`) | `core-utils` |
| `{{CATEGORY_NAME}}` | Feature category (in `docs-src/feature-request-automation.md`) | `data-pipeline` |
| `{{PROJECT_URL}}` | Public URL for your project (in `meta/ROBOT_ETHICS.md`) | `https://example.com` |

### 2. Customize Key Files

- **`README.md`** — Replace this content with your project's description.
- **`mkdocs.yml`** — Update site name, description, and URL after replacing placeholders.
- **`docs-src/index.md`** — Replace the placeholder setup instructions with your own.
- **`meta/DEVELOPMENT_PHILOSOPHY.md`** — Review and adjust principles to fit your project's needs.
- **`SECURITY.md`** — Update contact information for vulnerability reporting.

### 3. Preview the Starter Page

Open `src/index.html` directly in a browser — no build step or dev server required.

### 4. Build Your Application

Edit files in `src/` to build your frontend application:

- **`src/index.html`** — Add your HTML content with semantic markup
- **`src/assets/styles.css`** — Add your styles
- **`src/scripts/app.js`** — Add your JavaScript logic

### 5. Adding a Build Step (Optional)

The default setup requires no build step. If you need a bundler (e.g., for JSX, TypeScript, or module bundling), add your configuration at the project root:

- **Vite**: `npm create vite@latest . -- --template vanilla` and point `root` to `src/`
- **Webpack**: Add `webpack.config.js` at the project root
- **Parcel**: Run `npx parcel src/index.html`

Document your choice in a new ADR (see `meta/adr/TEMPLATE.md`).

### 6. Set Up Local Development

```bash
# Install pre-commit hooks
pip install pre-commit
pre-commit install

# Run local quality checks
./scripts/local-ci-check.sh

# Build documentation (optional)
pip install -r docs-requirements.txt
./scripts/build-docs.sh
```

### 7. Verify CI

Push a change or open a pull request to confirm the CI workflow runs and passes in your new repository.

### 8. Enable GitHub Pages Deployment

This template includes `.github/workflows/deploy-pages.yml`, which deploys `src/` to GitHub Pages on pushes to `main` and supports manual `workflow_dispatch`.

To enable it in your new repository:

1. Go to **Settings → Pages**
2. Under **Build and deployment**, set **Source** to **GitHub Actions**
3. (Optional but recommended) In **Settings → Environments → github-pages**, configure environment protection rules as needed
4. Push to `main` (or run the **Deploy to GitHub Pages** workflow manually) to publish your site

### 9. Opting into AWS Deployment

This template includes an optional `.github/workflows/deploy-aws.yml` workflow that deploys `src/` to an AWS S3 bucket and invalidates a CloudFront distribution. It is **disabled by default** — it only runs when triggered manually via `workflow_dispatch`. If you use a build step, update the sync source path in the workflow (see the commented build step instructions inside the file).

#### Required AWS Resources

Before enabling this workflow, you need the following AWS resources already provisioned (infrastructure setup is out of scope for this template):

| Resource | Description |
| :--- | :--- |
| **S3 bucket** | Stores the static site files |
| **CloudFront distribution** | Serves the site from S3 with HTTPS and caching |
| **GitHub OIDC identity provider** | Allows GitHub Actions to authenticate with AWS without static keys |
| **IAM role** | Trusted by the OIDC provider; grants permission to write to S3 and invalidate CloudFront |

#### GitHub Repository Variables

Configure the following in **Settings → Secrets and variables → Actions → Variables**:

| Variable | Description | Example |
| :--- | :--- | :--- |
| `AWS_ROLE_ARN` | ARN of the IAM role GitHub Actions will assume via OIDC | `arn:aws:iam::123456789012:role/my-deploy-role` |
| `AWS_REGION` | AWS region where your resources live (defaults to `us-east-1` if unset) | `us-west-2` |
| `S3_BUCKET_NAME` | Name of the S3 bucket to sync the site into | `my-project-static-site` |
| `CLOUDFRONT_DISTRIBUTION_ID` | ID of the CloudFront distribution to invalidate after deploy | `E1ABCDEF2GHIJK` |

#### Enabling the Workflow

1. Provision the AWS resources listed above.
2. Add the three repository variables listed above in **Settings → Secrets and variables → Actions → Variables**.
3. Go to **Actions → Deploy to AWS (S3 + CloudFront)** and click **Run workflow** to trigger a manual deployment.
4. (Optional) To deploy automatically on every push to `main`, add a `push` trigger to `.github/workflows/deploy-aws.yml`:

   ```yaml
   on:
     push:
       branches: [main]
     workflow_dispatch: {}
   ```

> **Note:** The GitHub Pages workflow (`.github/workflows/deploy-pages.yml`) remains the default deployment path and is unaffected by this workflow.

## Design Principles

- **Framework-agnostic.** The default is vanilla HTML/CSS/JS, but the structure supports any frontend framework or build tool.
- **No build step required.** Open `src/index.html` in a browser and start building.
- **Minimal by design.** Only universal scaffolding is included — add tools and dependencies as needed.
- **Documentation-first.** Every significant decision is captured in an ADR.
- **AI-friendly.** The structure and conventions are designed to work well with AI-assisted development workflows.

## License

This project is licensed under the [MIT License](./LICENSE.md).
