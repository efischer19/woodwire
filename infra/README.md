# AWS Infrastructure

This directory contains CloudFormation templates for provisioning the AWS resources that power Woodwire.

## Overview

Woodwire uses three CloudFormation stacks:

1. **Chat Bucket** — Private S3 bucket for message storage (inbox, outbox, attachments)
2. **Chat Queue** — AWS SQS queue and dead-letter queue for inbound messages
3. **IAM** — Least-privilege IAM users and GitHub Actions deployment role

## Stack Dependencies

```text
Chat Bucket (outputs: ChatBucketName, ChatBucketArn)
     ↓
Chat Queue (outputs: ChatQueueUrl, ChatQueueArn, ChatDeadLetterQueueArn)
     ↓
IAM Stack (requires all outputs from above)
```

**Deploy in order:** Chat Bucket → Chat Queue → IAM

---

## 1. Chat Bucket (`woodwire-chat-bucket.yaml`)

Private S3 bucket for storing Woodwire messages and attachments.

### Resources Created

- **S3 Bucket** with private access (no public reads)
- **CORS policy** allowing requests from your PWA origin
- **Prefix structure:**
  - `inbox/` — Temporary storage for inbound attachments
  - `outbox/` — Bot responses and reply attachments
  - `attachments/` — Long-term attachment storage

### Parameters

| Parameter | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `ChatBucketName` | Yes | — | Globally unique S3 bucket name (e.g., `woodwire-chat-bucket-acme-corp`) |
| `AllowedCorsOrigin` | Yes | — | PWA origin for CORS (e.g., `https://app.example.com`) |

### Deployment

```bash
aws cloudformation deploy \
  --stack-name woodwire-chat-bucket \
  --template-file infra/woodwire-chat-bucket.yaml \
  --parameter-overrides \
    ChatBucketName=woodwire-chat-bucket-your-org-id \
    AllowedCorsOrigin=https://app.example.com
```

### Outputs

| Output | Type | Used By |
| :--- | :--- | :--- |
| `ChatBucketName` | String | IAM stack, Worker, Local bot |
| `ChatBucketArn` | String | IAM stack, Worker, Local bot |

---

## 2. Chat Queue (`woodwire-chat-queue.yaml`)

AWS SQS queue for asynchronous message delivery from the Cloudflare Worker to the local bot.

### Resources Created

- **Primary SQS Queue** (Standard queue, 20-second default visibility)
- **Dead-Letter Queue (DLQ)** for failed messages after max retries
- **CloudWatch alarms** for queue depth monitoring

### Parameters

| Parameter | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `ChatQueueName` | Yes | — | Queue name (e.g., `woodwire-chat`) |

### Deployment

```bash
aws cloudformation deploy \
  --stack-name woodwire-chat-queue \
  --template-file infra/woodwire-chat-queue.yaml \
  --parameter-overrides \
    ChatQueueName=woodwire-chat
```

### Outputs

| Output | Type | Used By |
| :--- | :--- | :--- |
| `ChatQueueUrl` | String | IAM stack, Worker, Local bot |
| `ChatQueueArn` | String | IAM stack |
| `ChatDeadLetterQueueArn` | String | IAM stack (dead-letter queue for max retries) |

---

## 3. IAM Stack (`woodwire-iam.yaml`)

**Required region:** `us-east-1` (includes AWS Billing alarm)

Least-privilege IAM users and GitHub Actions OIDC role for secure deployments.

### Resources Created

- **LocalBotUser** — IAM user for the local bot (SQS receive/delete, S3 read/write)
- **CloudflareWorkerUser** — IAM user for the Worker (SQS send, S3 pre-signed URL generation)
- **GitHubActionsRole** — OIDC role for GitHub Actions CI/CD (S3 sync, CloudFront invalidation)
- **Billing Alarm** — Monitors AWS estimated charges in us-east-1

### Parameters

| Parameter | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `ProjectName` | No | `woodwire` | Prefix for IAM resource names |
| `ChatBucketName` | Yes | — | Private S3 bucket name (from Chat Bucket stack) |
| `ChatQueueArn` | Yes | — | SQS queue ARN (from Chat Queue stack) |
| `PwaHostingBucketName` | Yes | — | S3 bucket name for PWA static files |
| `CloudFrontDistributionId` | Yes | — | CloudFront distribution ID for cache invalidation |
| `GitHubRepositoryOwner` | Yes | — | Your GitHub username or organization |
| `GitHubRepositoryName` | Yes | — | Repository name (e.g., `woodwire`) |
| `GitHubBranchName` | No | `main` | Branch allowed to deploy via OIDC |
| `GitHubOidcProviderArn` | Yes | — | ARN of the GitHub Actions OIDC provider |
| `BillingAlarmSnsTopicArn` | Yes | — | SNS topic for billing alarm notifications |

### Deployment

```bash
aws cloudformation deploy \
  --stack-name woodwire-iam \
  --template-file infra/woodwire-iam.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1 \
  --parameter-overrides \
    ProjectName=woodwire \
    ChatBucketName=woodwire-chat-bucket-your-org-id \
    ChatQueueArn=arn:aws:sqs:us-east-1:123456789012:woodwire-chat \
    PwaHostingBucketName=woodwire-pwa \
    CloudFrontDistributionId=E1ABCDEF2GHIJK \
    GitHubRepositoryOwner=YOUR_GITHUB_USERNAME \
    GitHubRepositoryName=woodwire \
    GitHubOidcProviderArn=arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com \
    BillingAlarmSnsTopicArn=arn:aws:sns:us-east-1:123456789012:woodwire-billing-alerts
```

### Outputs

| Output | Type | Used By |
| :--- | :--- | :--- |
| `LocalBotAccessKeyUserName` | String | Create access keys for local bot |
| `CloudflareWorkerAccessKeyUserName` | String | Create access keys for Cloudflare Worker |
| `GitHubActionsRoleArn` | String | GitHub repository variable `AWS_ROLE_ARN` |

---

## Creating Access Keys

After deploying the IAM stack, create long-lived access keys for the bot and Worker:

### For the Local Bot

```bash
aws iam create-access-key \
  --user-name woodwire-local-bot-user

# Output:
# {
#   "AccessKey": {
#     "AccessKeyId": "AKIAIOSFODNN7EXAMPLE",
#     "SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
#   }
# }
```

Store these credentials in your `.env` file or safe storage (never in version control).

### For the Cloudflare Worker

```bash
aws iam create-access-key \
  --user-name woodwire-cloudflare-worker-user
```

Store these credentials as [Cloudflare Worker secrets](../worker/README.md).

---

## Setting Up GitHub Actions Deployment

1. Deploy the IAM stack (above)
2. Copy the `GitHubActionsRoleArn` output
3. Add to your GitHub repository:
   - **Settings → Secrets and variables → Actions → Variables**
     - `AWS_ROLE_ARN`: Paste the role ARN
     - `AWS_REGION`: `us-east-1` (or your region)
     - `S3_BUCKET_NAME`: `woodwire-pwa` (or your PWA hosting bucket)
     - `CLOUDFRONT_DISTRIBUTION_ID`: Your CloudFront distribution ID
4. Commit and push to `main` to trigger deployment

See [QUICK_START.md](../QUICK_START.md) for the full setup guide.

---

## Troubleshooting

### Stack creation fails: "CAPABILITY_NAMED_IAM is required"

Add `--capabilities CAPABILITY_NAMED_IAM` to your deploy command.

### "Parameter validation failed: Invalid value for parameter"

Verify all required parameters are provided and match the correct format:

- `ChatBucketName` must be globally unique and lowercase
- `ChatQueueArn` must be in format `arn:aws:sqs:region:account-id:queue-name`
- `GitHubOidcProviderArn` must exist in your AWS account

### Billing alarm doesn't receive notifications

- Ensure `BillingAlarmSnsTopicArn` is in **us-east-1** (billing metrics are only available there)
- Verify the SNS topic ARN is correct
- Check SNS subscription email was confirmed

### GitHub Actions deployment fails with "AssumeRole failed"

- Verify `GitHubRepositoryOwner` and `GitHubRepositoryName` match your actual GitHub repo
- Confirm the `GitHubBranchName` parameter matches your deployment branch
- Check GitHub repository variables are set correctly

---

## Cleanup

To delete all stacks (in reverse order):

```bash
# Delete IAM stack
aws cloudformation delete-stack --stack-name woodwire-iam --region us-east-1

# Delete Chat Queue stack
aws cloudformation delete-stack --stack-name woodwire-chat-queue

# Delete Chat Bucket stack (will fail if bucket is not empty)
aws s3 rm s3://woodwire-chat-bucket-your-org-id --recursive
aws cloudformation delete-stack --stack-name woodwire-chat-bucket
```

---

## See Also

- [QUICK_START.md](../QUICK_START.md) — Full setup guide
- [README.md](../README.md) — Architecture overview
- [bot/README.md](../bot/README.md) — Local bot documentation
- [worker/README.md](../worker/README.md) — Cloudflare Worker documentation
