# Woodwire

> Secure, asynchronous chat between a static web app and a local AI bot.

Woodwire is an event-driven system for private, multimodal communication between a browser-based PWA and a local bot process. The frontend stays static and credential-free, while a Cloudflare Worker and AWS services coordinate message flow.

## Architecture Overview

For full implementation details, see [`/meta/plans/`](./meta/plans/), especially the [epic executive summary](./meta/plans/epic-woodwire/00-executive-summary.md).

```text
[ Static PWA ]  ──────►  [ Cloudflare Worker ]  ──────►  [ AWS SQS Queue ]
  (S3/CloudFront)          · Passphrase auth               · Event buffer
                           · AWS secret injection           · Long-poll delivery
                           · Pre-signed URL gen                    │
                                                                   ▼
[ Private S3 ]  ◄────────  [ PWA polls Worker ]           [ Local Bot ]
  · outbox/ (AI replies)     for response status            · Outbound-only
  · attachments/                                            · OpenClaw/Ollama
```

## Repository Structure

Woodwire follows the monorepo layout defined in [ADR-006](./meta/adr/ADR-006-monorepo_structure.md):

```text
woodwire/
├── src/              # PWA frontend (HTML/CSS/JS) — deploys to S3
├── bot/              # Local Python bot — runs on user's machine
├── worker/           # Cloudflare Worker source — deploys to Cloudflare
├── infra/            # IaC templates (CloudFormation/Terraform)
├── meta/             # ADRs, plans, philosophy docs
└── .github/workflows # CI/CD for all artifacts
```

## Deploy Your Own (Quickstart)

1. Review architecture and sequencing in [`meta/plans/epic-woodwire/`](./meta/plans/epic-woodwire/).
2. Provision AWS resources (S3, SQS, IAM) from the infra templates and plan docs.
3. Deploy the Cloudflare Worker with passphrase auth and SQS forwarding.
4. Run the local bot and point it at your queue and storage config.
5. Deploy `src/` as the static PWA frontend.

### Provision the Chat Bucket

Provision the private chat bucket stack in `infra/woodwire-chat-bucket.yaml`
before wiring up IAM policies or Worker pre-signed URL generation. The stack
outputs `ChatBucketName` and `ChatBucketArn` for those downstream
configurations. Choose a globally unique S3 bucket name when setting
`ChatBucketName`.

```sh
aws cloudformation deploy \
  --stack-name woodwire-chat-bucket \
  --template-file infra/woodwire-chat-bucket.yaml \
  --parameter-overrides \
    ChatBucketName=woodwire-chat-bucket-your-org-id \
    AllowedCorsOrigin=https://app.example.com
```

### Provision the Chat Queue

Provision the primary SQS queue and its dead-letter queue in
`infra/woodwire-chat-queue.yaml` before deploying IAM policies, the Worker, or
the local bot. The stack outputs `ChatQueueUrl`, `ChatQueueArn`, and
`ChatDeadLetterQueueArn` for those downstream configurations.

```sh
aws cloudformation deploy \
  --stack-name woodwire-chat-queue \
  --template-file infra/woodwire-chat-queue.yaml \
  --parameter-overrides \
    ChatQueueName=woodwire-chat
```

### Run the Local Bot

The bot defaults to the `openclaw` backend and will POST messages plus local
attachment paths to `http://127.0.0.1:8080/process` unless you override
`OPENCLAW_URL` or the `OPENCLAW_HOST` / `OPENCLAW_PORT` / `OPENCLAW_PATH`
variables.

For a manual end-to-end smoke test without a local LLM, set `AI_BACKEND=mock`
and run:

```sh
export AI_BACKEND=mock
python bot/main.py
```

### Local Quality Checks

```bash
pip install pre-commit
pre-commit run --all-files
npx --yes markdownlint-cli2 "**/*.md"
npx --yes htmlhint "src/**/*.html"
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

This repository includes a `.github/workflows/deploy-aws.yml` workflow that deploys `src/` to an AWS S3 bucket and invalidates a CloudFront distribution. It runs on manual `workflow_dispatch` and on pushes to `main` when files under `src/` change. If you add a build step later, update the S3 sync source path in the workflow by following the commented Node/build example in `.github/workflows/deploy-aws.yml`.

#### Required AWS Resources

Before enabling this workflow, provision the following AWS resources. The IAM
users, managed policies, GitHub Actions OIDC role, and the $1.00 billing alarm
can be created with `infra/woodwire-iam.yaml` by deploying the stack in
`us-east-1`:

```sh
aws cloudformation deploy \
  --stack-name woodwire-iam \
  --template-file infra/woodwire-iam.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1 \
  --parameter-overrides \
    ProjectName=woodwire \
    ChatBucketName=woodwire-chat-bucket \
    ChatQueueArn=arn:aws:sqs:us-east-1:123456789012:woodwire-chat \
    PwaHostingBucketName=woodwire-pwa \
    CloudFrontDistributionId=E1ABCDEF2GHIJK \
    GitHubRepositoryOwner=YOUR_GITHUB_USERNAME \
    GitHubRepositoryName=woodwire \
    GitHubOidcProviderArn=arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com \
    BillingAlarmSnsTopicArn=arn:aws:sns:us-east-1:123456789012:woodwire-billing-alerts
```

After the stack finishes, copy the `GitHubActionsRoleArn` output into the
`AWS_ROLE_ARN` repository variable. Create long-lived access keys manually for
the `LocalBotAccessKeyUserName` and `CloudflareWorkerAccessKeyUserName`
outputs, then store those credentials outside this repository.

| Resource | Description |
| :--- | :--- |
| **S3 bucket** | Stores the static site files |
| **CloudFront distribution** | Serves the site from S3 with HTTPS and caching |
| **GitHub OIDC identity provider** | Allows GitHub Actions to authenticate with AWS without static keys |
| **IAM role** | Created by `infra/woodwire-iam.yaml`; trusted by the OIDC provider and scoped to S3 deploys plus CloudFront invalidations |

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
2. Add the repository variables from the **GitHub Repository Variables** table above in **Settings → Secrets and variables → Actions → Variables**.
3. Go to **Actions → Deploy to AWS (S3 + CloudFront)** and click **Run workflow** to trigger a manual deployment.
4. Push a change to `src/` on `main` to use the automatic path-scoped deployment.

> **Note:** The GitHub Pages workflow (`.github/workflows/deploy-pages.yml`) remains the default deployment path and is unaffected by this workflow.

### 10. Opting into Cloudflare Worker Deployment

This repository also includes `.github/workflows/deploy-worker.yml`, a Cloudflare Worker deployment workflow. It runs on manual `workflow_dispatch` and on pushes to `main` when files under `worker/` change. The workflow installs the official `wrangler` CLI with `npm` and deploys with a GitHub Actions secret-backed API token.

#### GitHub Repository Secret

Configure the following in **Settings → Secrets and variables → Actions → Secrets**:

| Secret | Description |
| :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with permission to deploy the Worker |

#### GitHub Repository Variable

Configure the following in **Settings → Secrets and variables → Actions → Variables**:

| Variable | Description | Example |
| :--- | :--- | :--- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account identifier used by `wrangler deploy` | `0123456789abcdef0123456789abcdef` |

#### Enabling the Workflow

1. Add the `CLOUDFLARE_API_TOKEN` secret and `CLOUDFLARE_ACCOUNT_ID` variable.
2. Scaffold the Worker project under `worker/` with a `wrangler.toml` (or `wrangler.json` / `wrangler.jsonc`) file.
3. Go to **Actions → Deploy Cloudflare Worker** and click **Run workflow** to trigger a manual deployment.
4. Push a change to `worker/` on `main` to use the automatic path-scoped deployment.

## Design Principles

Development standards and contributor expectations are documented in [`meta/DEVELOPMENT_PHILOSOPHY.md`](./meta/DEVELOPMENT_PHILOSOPHY.md).

## License

This project is licensed under the [MIT License](./LICENSE.md).
