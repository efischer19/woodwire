# feat: Add CloudWatch Alarm for SQS Dead-Letter Queue

## What do you want to build?

Add a CloudWatch alarm to the existing SQS infrastructure template that fires
when any message lands in the dead-letter queue. This is the single most
critical observability gap in the system: failed messages currently accumulate
silently with no notification. The alarm should publish to an SNS topic so
operators can receive email, SMS, or webhook alerts when the bot fails to
process a message after three retries.

## Acceptance Criteria

- [ ] `infra/woodwire-chat-queue.yaml` is updated to include a `AWS::CloudWatch::Alarm` resource that triggers when `ApproximateNumberOfMessagesVisible` on the dead-letter queue is greater than 0
- [ ] The alarm evaluates over a 1-minute period with 1 evaluation period (fires as soon as a message appears)
- [ ] The alarm publishes to an SNS topic ARN provided via a new `AlarmSnsTopicArn` parameter (optional — alarm is created regardless, but the `AlarmActions` list is only populated when the parameter is non-empty)
- [ ] The alarm resource name is `ChatDeadLetterQueueAlarm`
- [ ] The alarm description clearly states: "One or more messages have been routed to the Woodwire dead-letter queue after exhausting retries"
- [ ] The alarm uses the `SQS` namespace and `QueueName` dimension referencing the DLQ
- [ ] The `AlarmSnsTopicArn` parameter includes a constraint description explaining it is optional
- [ ] Existing outputs and resources are not modified
- [ ] The template passes `aws cloudformation validate-template`

## Implementation Notes (Optional)

**CloudWatch alarm resource to add:**

```yaml
AlarmSnsTopicArn:
  Type: String
  Default: ''
  Description: >-
    Optional SNS topic ARN for dead-letter queue alarms. Leave empty to
    create the alarm without a notification target.

Conditions:
  HasAlarmSnsTopic:
    Fn::Not:
      - Fn::Equals:
          - Ref: AlarmSnsTopicArn
          - ''

ChatDeadLetterQueueAlarm:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName:
      Fn::Sub: '${ChatQueueName}-dlq-messages'
    AlarmDescription: >-
      One or more messages have been routed to the Woodwire dead-letter
      queue after exhausting retries.
    Namespace: AWS/SQS
    MetricName: ApproximateNumberOfMessagesVisible
    Dimensions:
      - Name: QueueName
        Value:
          Fn::GetAtt:
            - ChatDeadLetterQueue
            - QueueName
    Statistic: Maximum
    Period: 60
    EvaluationPeriods: 1
    Threshold: 0
    ComparisonOperator: GreaterThanThreshold
    TreatMissingData: notBreaching
    AlarmActions:
      Fn::If:
        - HasAlarmSnsTopic
        - - Ref: AlarmSnsTopicArn
        - Ref: AWS::NoValue
```

**File to modify:** `infra/woodwire-chat-queue.yaml`

Add the `AlarmSnsTopicArn` parameter, the `HasAlarmSnsTopic` condition, and the
`ChatDeadLetterQueueAlarm` resource. Do not modify any existing resources or
outputs.
