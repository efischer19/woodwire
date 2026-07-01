# feat: Add SQS Message Body Size Validation to Worker

## What do you want to build?

Add a request body size check to the Cloudflare Worker's `handleMessageRequest`
function before attempting to enqueue the message to SQS. SQS enforces a 256 KB
maximum message body size. Currently, the Worker serializes the payload and
sends it to SQS without checking the size — a crafted request with a very long
`text` field or many attachment keys could cause an unhandled SQS `InvalidParameterValue`
error that surfaces as a generic `502 Bad Gateway` to the user. Validating the
size before the SQS call allows the Worker to return a clear `413 Payload Too Large`
response.

## Acceptance Criteria

- [ ] `worker/src/index.js` `handleMessageRequest` checks the byte length of the serialized SQS payload before calling `SendMessageCommand`
- [ ] If the payload exceeds 256 KB (262,144 bytes), the Worker returns HTTP `413` with `{ "error": "Message payload is too large" }`
- [ ] The size check uses `new TextEncoder().encode(payloadString).byteLength` to correctly count multi-byte characters
- [ ] The 256 KB limit is defined as a named constant (`MAX_SQS_MESSAGE_BYTES = 262144`)
- [ ] Existing message validation (text, attachments format) still runs before the size check
- [ ] Worker unit tests verify that an oversized payload returns 413
- [ ] Worker unit tests verify that a payload just under the limit is accepted normally
- [ ] The `worker/README.md` documents the maximum message size constraint

## Implementation Notes (Optional)

**Size check to add** (after payload construction, before `sqsClient.send`):

```javascript
const MAX_SQS_MESSAGE_BYTES = 262144;

const payloadString = JSON.stringify(payload);
const payloadBytes = new TextEncoder().encode(payloadString).byteLength;

if (payloadBytes > MAX_SQS_MESSAGE_BYTES) {
  return createResponse(request, env, 413, { error: 'Message payload is too large' });
}
```

**Files to modify:**

- `worker/src/index.js`: Add `MAX_SQS_MESSAGE_BYTES` constant, add size check
  in `handleMessageRequest`
- `worker/src/index.test.js`: Add tests for oversized and boundary payloads
- `worker/README.md`: Document the 256 KB message limit
