# feat: Notify When a Reply Arrives While the Tab Is Hidden

## What do you want to build?

Offer an opt-in system notification when an AI reply arrives while the
Woodwire tab is hidden or backgrounded. Replies are asynchronous and can take
a while (especially voice replies), so users often switch away after sending.

**Constraint:** the PWA currently stops polling completely when
`document.hidden` is true (the `visibilitychange` listener in `initChatApp()`,
added by the day-2 audit ticket 06 to save rate-limit budget). With no polling
while hidden there's nothing to trigger a notification, so this ticket adds a
throttled background poll that runs only when notifications are enabled. This
is not real Web Push; that would need a push service and a new architecture
decision, and is out of scope.

## Acceptance Criteria

- [ ] Connection settings include a "Notify me when replies arrive" checkbox, off by default, stored in `localStorage`
- [ ] Turning it on calls `Notification.requestPermission()`; if denied, the checkbox reverts and a flash message explains why
- [ ] When enabled and permission is granted, polling continues while the tab is hidden at a slower interval (e.g. 30 s, defined as a named constant) instead of stopping; when disabled, the current stop-while-hidden behavior is unchanged
- [ ] When `pollConversation()` appends a reply while `document.hidden` is true, a notification is shown through the service worker registration (`registration.showNotification`) with the conversation name and a short text preview
- [ ] With E2EE enabled, the preview is generic ("New reply in <conversation>") unless the user opts into previews, since notification text can appear on a lock screen
- [ ] Clicking the notification focuses an existing Woodwire window (or opens one) and switches to that conversation; `src/sw.js` handles `notificationclick`
- [ ] No notification is shown when the tab is visible
- [ ] Polling still stops while hidden once there are no pending conversations
- [ ] Feature-detected: if `Notification` or service workers are missing (e.g. iOS Safari outside an installed PWA), the checkbox is hidden

## Implementation Notes (Optional)

**Files to modify:** `src/scripts/app.js`, `src/index.html`, `src/sw.js`

- The hidden-tab branch of the `visibilitychange` listener calls
  `stopPollingLoop(state)`; gate that on the new preference and use
  `ensurePollingLoop(elements, state, HIDDEN_POLL_INTERVAL_MS)` instead.
- `runPollingCycle()` takes `nextDelayMs` from `pollConversation()`; when
  hidden, use `Math.max(nextDelayMs, HIDDEN_POLL_INTERVAL_MS)`.
- Browsers throttle background timers to roughly once per minute anyway, so a
  30 s target is a ceiling, not a guarantee. Document this in `src/README.md`.
- Pass the `conversationId` in the notification's `data` so the
  `notificationclick` handler can `postMessage` it to the client.
