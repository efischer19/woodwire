# feat: Integrate PWA with Cloudflare Worker for Text Chat

## What do you want to build?

Connect the PWA chat interface (built in Ticket 10) to the Cloudflare Worker
API (built in Ticket 06) to enable end-to-end text messaging. The user types a
message, the PWA sends it to the Worker, and then polls for the AI's response
until it arrives.

## Acceptance Criteria

- [ ] Sending a message in the PWA calls `POST /api/message` on the Cloudflare Worker with the `X-Woodwire-Auth` header
- [ ] The PWA displays a "sending..." indicator while the message is in flight
- [ ] After sending, the PWA begins polling `GET /api/status/:conversationId` at a configurable interval (default: 3 seconds)
- [ ] When the status indicates "complete", the PWA fetches the response via `GET /api/response/:conversationId` and displays it in the chat
- [ ] Polling stops after the response is retrieved (no unnecessary requests)
- [ ] If the Worker returns `401`, the PWA prompts the user to re-enter the passphrase
- [ ] If the Worker returns `429` (rate limited), the PWA displays a user-friendly message and backs off
- [ ] Network errors during send or poll are handled gracefully — the message is queued for retry (per the offline queue from Ticket 10)
- [ ] The Worker base URL is configurable via a JavaScript constant (not hardcoded)
- [ ] The chat displays timestamps on messages in the user's local timezone
- [ ] All messages (sent and received) persist in `localStorage` so the chat history survives page reloads

## Implementation Notes (Optional)

**Worker base URL configuration:** Define the Worker URL as a constant at the
top of the main JS file:

```javascript
const WORKER_BASE_URL = 'https://woodwire.your-domain.workers.dev';
```

This will be replaced at deploy time or made configurable in a future ticket.

**Polling strategy:**

1. After sending a message, start polling `GET /api/status/:conversationId`
   every 3 seconds.
2. If the response is "pending" or "processing", continue polling.
3. If the response is "complete", fetch the full response and stop polling.
4. If no response after 5 minutes, show a timeout message and stop polling.
5. Never have more than one active poll loop running at a time.

**LocalStorage chat history format:**

```json
[
  { "id": "uuid", "role": "user", "text": "Hello", "timestamp": "..." },
  { "id": "uuid", "role": "ai", "text": "Hi there!", "timestamp": "..." }
]
```

Cap stored messages at 200 to prevent `localStorage` from growing unbounded.

**Error handling UX:**

- 401: "Authentication failed. Please re-enter your passphrase."
- 429: "Too many requests. Please wait a moment."
- Network error: "Connection lost. Message will be sent when you're back online."
- Timeout: "The AI is taking longer than expected. Your message was received and will be processed."
