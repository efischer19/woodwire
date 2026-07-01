# feat: Add AbortIncompleteMultipartUpload Lifecycle Rule to S3 Bucket

## What do you want to build?

Add an `AbortIncompleteMultipartUpload` lifecycle rule to the S3 chat bucket
CloudFormation template. When a PWA presigned PUT upload fails mid-transfer
(network drop, browser tab closed, mobile app backgrounded), S3 retains the
incomplete multipart upload parts indefinitely. These orphaned parts accumulate
storage costs and are invisible to the application. The lifecycle rule
automatically aborts incomplete uploads after a configured number of days.

## Acceptance Criteria

- [ ] `infra/woodwire-chat-bucket.yaml` adds a new lifecycle rule with `Id: AbortIncompleteMultipartUploads`
- [ ] The rule applies to all prefixes (no `Prefix` filter, or empty prefix) so it covers `inbox/`, `outbox/`, and `attachments/`
- [ ] The rule sets `AbortIncompleteMultipartUpload.DaysAfterInitiation` to `1` (24 hours — uploads should complete within minutes; 1 day provides a generous buffer)
- [ ] The rule `Status` is `Enabled`
- [ ] Existing lifecycle rules (`ExpireInboxAfter48Hours`, `ExpireOutboxAfter48Hours`, `ExpireAttachmentsAfter48Hours`) are not modified
- [ ] The template passes `aws cloudformation validate-template`
- [ ] A comment in the template explains why the rule exists (orphaned multipart uploads from failed presigned PUTs)

## Implementation Notes (Optional)

**Lifecycle rule to add** (inside the existing `LifecycleConfiguration.Rules`
list in `infra/woodwire-chat-bucket.yaml`):

```yaml
# Abort incomplete multipart uploads after 1 day. Failed presigned PUT
# uploads from the PWA leave orphaned parts that never expire without
# this rule.
- Id: AbortIncompleteMultipartUploads
  Status: Enabled
  AbortIncompleteMultipartUpload:
    DaysAfterInitiation: 1
```

**File to modify:** `infra/woodwire-chat-bucket.yaml`

Add the rule as a new entry in the existing `Rules` list under
`LifecycleConfiguration`. No other changes needed.
