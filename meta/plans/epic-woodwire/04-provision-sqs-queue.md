# feat: Provision SQS Queue with Dead-Letter Queue

## What do you want to build?

Create an Infrastructure-as-Code template to provision the AWS SQS queue that
serves as Woodwire's event buffer between the Cloudflare Worker (message
producer) and the local bot (message consumer). Include a dead-letter queue
to capture messages that fail processing after repeated retries.

## Acceptance Criteria

- [ ] An IaC template creates a standard (not FIFO) SQS queue with a configurable name
- [ ] Long polling is enabled with a `ReceiveMessageWaitTimeSeconds` of 20
- [ ] Default visibility timeout is set to 120 seconds (per ADR-004)
- [ ] Message retention period is set to 7 days (sufficient buffer for offline bot scenarios)
- [ ] A dead-letter queue (DLQ) is created and associated with the main queue
- [ ] The DLQ redrive policy triggers after 3 failed delivery attempts (`maxReceiveCount: 3`)
- [ ] The template outputs the queue URL, queue ARN, and DLQ ARN for use by IAM policies
- [ ] The template includes comments documenting the SQS Free Tier limit (1 million requests/month)
- [ ] The template can be deployed with a single CLI command

## Implementation Notes (Optional)

Place the IaC template in `infra/` alongside the S3 template from Ticket 03.

Key SQS configuration values and their rationale:

| Setting | Value | Rationale |
| :--- | :--- | :--- |
| `ReceiveMessageWaitTimeSeconds` | 20 | Maximum long-poll duration; minimizes empty responses |
| `VisibilityTimeout` | 120 | Exceeds worst-case AI processing time (ADR-004) |
| `MessageRetentionPeriod` | 604800 (7 days) | Survives extended bot downtime without message loss |
| `MaxReceiveCount` (DLQ) | 3 | Prevents infinite retry loops on poison messages |

**Free Tier context:** SQS Free Tier provides 1 million requests per month
(permanently, not just 12 months). At ~50K expected requests/month, usage
stays at ~5% of the free tier.

The DLQ should have the same encryption and retention settings as the main
queue. Consider adding a CloudWatch alarm on the DLQ message count (covered
in Ticket 05's billing alarm).
