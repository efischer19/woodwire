# Quick Start Guide

This guide walks you through deploying Woodwire in your own AWS account and running the local bot.

## Prerequisites

- An AWS account
- [The `aws` CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) configured with credentials
- A Cloudflare account and Workers subscription
- [Node.js](https://nodejs.org/) (v18+) for the Worker
- [Python 3.10+](https://www.python.org/) and [uv](https://docs.astral.sh/uv/getting-started/installation/) for the bot
- A local LLM backend ([OpenClaw](https://github.com/jatincpl/openclaw) or [Ollama](https://ollama.ai/)) or use the mock backend for testing

## Architecture Quickstart

Woodwire's message flow involves two distinct pipelines:

**Inbound Pipeline (Browser → SQS):**

```text
[ Browser PWA ]  ──►  [ Cloudflare Worker ]  ──►  [ AWS SQS Queue ]
   (Static)         (Zero-trust gateway)     (Event buffer)
```

**Outbound Pipeline (S3 → Browser):**

```text
[ Local Bot ]  ──►  [ Private S3 Bucket ]  ──►  [ Browser polls Worker ]
  (OpenClaw/etc)      (outbox/ responses)       (for status checks)
```

## Step 1: Provision AWS Infrastructure

### 1.1 Create the Chat Bucket

```bash
aws cloudformation deploy \
  --stack-name woodwire-chat-bucket \
  --template-file infra/woodwire-chat-bucket.yaml \
  --parameter-overrides \
    ChatBucketName=woodwire-chat-bucket-<YOUR_ORG_ID> \
    AllowedCorsOrigin=https://app.example.com
```

**Note:** Choose a globally unique S3 bucket name. Save the `ChatBucketName` and `ChatBucketArn` outputs.

### 1.2 Create the Chat Queue

```bash
aws cloudformation deploy \
  --stack-name woodwire-chat-queue \
  --template-file infra/woodwire-chat-queue.yaml \
  --parameter-overrides \
    ChatQueueName=woodwire-chat
```

Save the `ChatQueueUrl`, `ChatQueueArn`, and `ChatDeadLetterQueueArn` outputs.

### 1.3 Provision IAM Roles and GitHub Actions Permissions (Optional)

If you want to deploy the app from GitHub Actions to AWS S3 + CloudFront:

```bash
aws cloudformation deploy \
  --stack-name woodwire-iam \
  --template-file infra/woodwire-iam.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1 \
  --parameter-overrides \
    ProjectName=woodwire \
    ChatBucketName=<YOUR_CHAT_BUCKET_NAME> \
    ChatQueueArn=<YOUR_CHAT_QUEUE_ARN> \
    PwaHostingBucketName=woodwire-pwa \
    CloudFrontDistributionId=<YOUR_CLOUDFRONT_DISTRIBUTION_ID> \
    GitHubRepositoryOwner=<YOUR_GITHUB_USERNAME> \
    GitHubRepositoryName=woodwire \
    GitHubOidcProviderArn=<YOUR_GITHUB_OIDC_PROVIDER_ARN> \
    BillingAlarmSnsTopicArn=<YOUR_SNS_TOPIC_ARN>
```

> **Important:** Deploy this stack in **us-east-1** because it includes the AWS Billing estimated charges alarm.

## Step 2: Deploy the Cloudflare Worker

### 2.1 Set Up Worker Secrets and Variables

```bash
cd worker

# Store the shared authentication passphrase
wrangler secret put WOODWIRE_AUTH

# Store AWS credentials (from your IAM user or temporary credentials)
wrangler secret put AWS_ACCESS_KEY_ID
wrangler secret put AWS_SECRET_ACCESS_KEY

# Optional: For temporary credentials, also set the session token
wrangler secret put AWS_SESSION_TOKEN
```

### 2.2 Configure Worker Environment Variables

Edit `worker/wrangler.toml` and set:

```toml
[env.production]
vars = {
  AWS_REGION = "us-east-1",
  CHAT_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/woodwire-chat",
  CHAT_BUCKET_NAME = "woodwire-chat-bucket-your-org-id",
  PWA_ORIGIN = "https://app.example.com",
  RATE_LIMIT_REQUESTS = "30",
  RATE_LIMIT_WINDOW_SECONDS = "60",
  STATUS_CACHE_TTL_SECONDS = "3"
}
```

### 2.3 Test and Deploy

```bash
# Test the Worker locally
npx --yes vitest run worker/index.test.js
npx wrangler deploy --dry-run

# Deploy to production
npx wrangler deploy
```

See [worker/README.md](./worker/README.md) for full configuration details.

## Step 3: Run the Local Bot

### 3.1 Set Up Bot Configuration

Create a `.env` file in the repository root:

```dotenv
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=us-east-1
SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/woodwire-chat
S3_BUCKET_NAME=woodwire-chat-bucket-your-org-id
AI_BACKEND=openclaw
OPENCLAW_URL=http://127.0.0.1:8080/process

# Optional: Enable client-side end-to-end encryption (32-byte base64 key)
# WOODWIRE_E2EE_KEY=your-base64-encoded-32-byte-key
```

### 3.2 Install Dependencies and Run

```bash
cd bot
uv sync
source .venv/bin/activate
python main.py
```

Or use `uv run` directly:

```bash
cd bot
uv sync
PYTHONPATH=.. uv run python main.py
```

### 3.3 Test with Mock Backend (No LLM Required)

For a quick smoke test without setting up OpenClaw:

```bash
cd bot
AI_BACKEND=mock uv run python main.py
```

See [bot/README.md](./bot/README.md) for full setup and troubleshooting.

## Step 4: Deploy the Frontend PWA

### 4.1 Option A: Manual Deployment to S3

```bash
aws s3 sync src/ s3://woodwire-pwa/ \
  --delete \
  --cache-control "public, max-age=3600"

# Invalidate CloudFront cache (if using CloudFront)
aws cloudfront create-invalidation \
  --distribution-id E1ABCDEF2GHIJK \
  --paths "/*"
```

### 4.2 Option B: GitHub Actions Deployment

1. Provision the IAM resources (Step 1.3 above)
2. Add repository variables in **Settings → Secrets and variables → Actions → Variables**:
   - `AWS_ROLE_ARN`: Your GitHub Actions IAM role
   - `AWS_REGION`: `us-east-1`
   - `S3_BUCKET_NAME`: Your PWA hosting bucket name
   - `CLOUDFRONT_DISTRIBUTION_ID`: Your CloudFront distribution ID
3. Push to `main` to trigger automatic deployment, or run the workflow manually

See [src/README.md](./src/README.md) for development details.

## Step 5: Test the Complete Setup

### 5.1 Verify the Worker is Running

```bash
curl https://your-worker.your-username.workers.dev/api/health
# Expected response: {"status":"ok"}
```

### 5.2 Open the PWA in Your Browser

- Navigate to your deployed app URL
- Enter the shared passphrase (from Step 2.1)
- Try sending a message and verify it reaches your bot process

### 5.3 Verify Message Flow

1. Send a message from the PWA
2. Check bot logs to see the inbound message
3. Verify the bot's response appears in S3 (`s3://your-bucket/outbox/`)
4. Refresh the PWA to see the response

## Step 6: Optional Features

### Voice Memo Support

The bot automatically processes audio attachments if you have `ffmpeg` installed and voice engines configured. See [bot/README.md](./bot/README.md) for details.

### Client-Side End-to-End Encryption

Set `WOODWIRE_E2EE_KEY` in your bot `.env` file and the PWA settings to enable AES-256-GCM encryption. The Worker never receives the key. See [README.md](./README.md) for details.

### GitHub Pages Deployment

For a quick GitHub-hosted demo:

1. Go to **Settings → Pages**
2. Set **Source** to **GitHub Actions**
3. Push to `main` to deploy `src/` automatically

## Troubleshooting

### Bot won't connect to SQS

- Verify `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` have SQS permissions
- Check `SQS_QUEUE_URL` is correct (from Step 1.2)
- Confirm the bot is in the same AWS region

### Worker returns 401 Unauthorized

- Verify `WOODWIRE_AUTH` passphrase matches between Worker and PWA
- Check the `X-Woodwire-Auth` header is being sent in browser requests

### Messages don't reach the bot

- Check bot logs for SQS connection errors
- Verify `CHAT_BUCKET_NAME` and `CHAT_QUEUE_URL` match your CloudFormation outputs
- Ensure the IAM user has S3 and SQS permissions

### Voice memos fail to process

- Install `ffmpeg`: `brew install ffmpeg` (macOS) or `apt-get install ffmpeg` (Linux)
- Set `PIPER_MODEL_PATH` to your downloaded voice model file
- Check bot logs for `VoiceEngineUnavailableError` warnings

## Next Steps

- Read [meta/DEVELOPMENT_PHILOSOPHY.md](./meta/DEVELOPMENT_PHILOSOPHY.md) to understand the project's design principles
- Explore [meta/adr/](./meta/adr/) for architectural decision records
- Review component-specific documentation: [src/README.md](./src/README.md), [worker/README.md](./worker/README.md), [bot/README.md](./bot/README.md), [infra/README.md](./infra/README.md)

## Support

This is a personal project built for my own use. While you're welcome to clone it and use it, expect limited maintenance and support. For issues, feature requests, or questions, feel free to open a GitHub issue.
