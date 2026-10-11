# feat: Add Copy and Retry Actions to Messages

## What do you want to build?

Add small per-message action buttons in the PWA chat history:

- **Copy** on assistant replies: copies the reply's raw text (Markdown source)
  to the clipboard.
- **Retry** on user messages that ended in an error state: resends the same
  text to the same conversation as a new message.

Messages that hit the 5-minute `POLL_TIMEOUT_MS` in `pollConversation()`, or
fail with a non-retryable Worker error, currently show an error status with no
way to resend except retyping.

## Acceptance Criteria

- [ ] Assistant messages show a Copy button that writes the original reply text to the clipboard with `navigator.clipboard.writeText()`
- [ ] After copying, the button briefly shows "Copied" and the change is announced through the existing `announce()` live region
- [ ] User messages whose status is an error (rendered with `isError = true` by `updateMessageStatus()`) show a Retry button
- [ ] Retry creates a new local message with the same text and `conversationId` and sends it through the existing `sendMessage()` path, including offline queueing
- [ ] Retry does not resend attachments; if the original message had attachments, the button label or tooltip says text-only
- [ ] Buttons are real `<button type="button">` elements with accessible labels, reachable by keyboard, and visible on focus (not hover-only, so they work on touch)
- [ ] Buttons render for messages restored from `localStorage` on reload, not only for newly appended ones
- [ ] Styling works in light and dark themes and doesn't crowd the existing `message-meta` row

## Implementation Notes (Optional)

**Files to modify:** `src/scripts/app.js`, `src/assets/styles.css`

- `appendMessage()` builds each `<article>`; add a `.message-actions`
  container there, based on `message.variant` and status.
- `updateMessageStatus()` changes status in place, so it needs to show or hide
  the Retry button when a message moves into or out of an error state.
- Use event delegation on `elements.messageHistory`, keyed on
  `data-action` plus the article's `data-local-id`, rather than a listener per
  button.
- Clipboard writes require a secure context; Woodwire is always served over
  HTTPS, but handle a rejected promise with a flash message anyway.
