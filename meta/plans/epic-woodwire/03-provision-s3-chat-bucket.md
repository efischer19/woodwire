# feat: Provision S3 Chat Bucket with Lifecycle Policies

## What do you want to build?

Create an Infrastructure-as-Code template to provision the private S3 bucket
that serves as Woodwire's message and media store. The bucket must have strict
access controls, server-side encryption, CORS configuration for pre-signed
uploads, and a 48-hour lifecycle policy to prevent storage buildup.

## Acceptance Criteria

- [ ] An IaC template (CloudFormation or Terraform) creates an S3 bucket with a configurable name
- [ ] The bucket has `BlockPublicAccess` set to block all public access (all four settings enabled)
- [ ] Server-side encryption is enabled using AES-256 (SSE-S3)
- [ ] A lifecycle rule automatically deletes objects under `inbox/`, `outbox/`, and `attachments/` prefixes after 48 hours
- [ ] CORS is configured to allow PUT requests from the Woodwire domain (configurable origin)
- [ ] Versioning is disabled (no need for version history on ephemeral chat data)
- [ ] The template outputs the bucket name and ARN for use by downstream IAM and Worker configurations
- [ ] The template includes comments documenting which AWS Free Tier limits apply (5 GB storage, 2,000 PUT, 20,000 GET requests/month)
- [ ] The template can be deployed with a single CLI command (`aws cloudformation deploy` or `terraform apply`)

## Implementation Notes (Optional)

Place the IaC template in `infra/` per the monorepo structure defined in
ADR-006.

CORS configuration must allow:

- **AllowedOrigins:** The Woodwire PWA domain (parameterized)
- **AllowedMethods:** `PUT`, `GET`
- **AllowedHeaders:** `Content-Type`, `x-amz-content-sha256`
- **MaxAgeSeconds:** `3600`

The 48-hour lifecycle policy applies to prefixed paths only. The bucket root
and any future static hosting paths should not be affected by the lifecycle
rule.

**Free Tier context:** S3 Free Tier provides 5 GB of standard storage, 20,000
GET requests, and 2,000 PUT requests per month for the first 12 months.
The 48-hour lifecycle policy ensures storage stays well under 5 GB.
