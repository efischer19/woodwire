# feat: Create Least-Privilege IAM Policies and Roles

## What do you want to build?

Create Infrastructure-as-Code templates for all IAM roles and policies required
by Woodwire. Each component (local bot, Cloudflare Worker, GitHub Actions) gets
its own narrowly scoped role with explicit deny-all defaults. This ticket also
provisions a CloudWatch billing alarm to catch any accidental free tier
overages.

## Acceptance Criteria

- [ ] An IAM policy for the **local bot** grants only: `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:ChangeMessageVisibility` on the specific queue ARN; `s3:GetObject`, `s3:PutObject` on the specific bucket ARN with prefix restrictions (`inbox/*`, `outbox/*`, `attachments/*`)
- [ ] An IAM policy for the **Cloudflare Worker** grants only: `sqs:SendMessage` on the specific queue ARN; `s3:PutObject` (for generating pre-signed PUT URLs) and `s3:GetObject` (for generating pre-signed GET URLs and checking response status) on the specific bucket ARN with prefix restrictions
- [ ] An IAM role for **GitHub Actions OIDC** grants only: `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on the PWA hosting bucket; `cloudfront:CreateInvalidation` on the specific distribution
- [ ] All IAM policies use explicit resource ARNs — no wildcards on resource fields
- [ ] All IAM policies include an explicit `Deny` statement for any action not explicitly allowed (belt and suspenders)
- [ ] A CloudWatch billing alarm is created that triggers at $1.00 estimated charges
- [ ] The billing alarm sends a notification to a configurable SNS topic (email)
- [ ] The IaC template outputs all role ARNs and access key references for downstream configuration
- [ ] The template can be deployed with a single CLI command

## Implementation Notes (Optional)

Place the IaC template in `infra/` alongside the S3 and SQS templates.

**IAM policy structure** — Use separate managed policies attached to dedicated
IAM users/roles rather than inline policies. This makes auditing easier.

**Local bot credentials** — The bot needs long-lived credentials (IAM access
key) since it runs on a local machine without OIDC. Store the access key
securely on the local machine (environment variables or a `.env` file outside
the repo). The IaC template should create the IAM user but the access key
should be generated manually via the console or CLI to avoid storing it in
state files.

**Cloudflare Worker credentials** — Similarly, the Worker needs an IAM access
key stored as encrypted Cloudflare Worker secrets. The IaC creates the user;
the key is manually provisioned.

**Billing alarm** — The CloudWatch billing alarm must be created in
`us-east-1` regardless of the primary region, as AWS billing metrics are only
available in that region.

**Security principle:** Every IAM entity in this project follows the pattern:
*explicit allow on specific resources, explicit deny on everything else.*
