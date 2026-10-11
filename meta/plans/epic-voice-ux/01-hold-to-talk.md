# feat: Hold-to-Talk Voice Messages

## What do you want to build?

Add a one-gesture "walkie-talkie" voice message to the PWA: a microphone
button in the main composer bar (next to Send) that records while held and
sends the voice memo when released, with no typed text required.

Today recording sits in the attachment drawer and needs record → stop → attach
→ type text → send. Typed text is required because the composer `submit`
handler returns early on an empty textarea and the Worker rejects empty
`text`. The bot already handles attachment-only messages.

## Acceptance Criteria

- [ ] A mic button appears in `.composer-primary-actions` when `supportsVoiceMemoRecording()` is true
- [ ] Press and hold (pointer and touch, using Pointer Events with `setPointerCapture`) starts recording; releasing stops it and sends the memo as a message in the active conversation
- [ ] Dragging off the button before release cancels the recording, and the recording UI shows a "release to send, slide away to cancel" hint
- [ ] Keyboard path: Space/Enter toggles record → stop-and-send, since holding a key isn't a reasonable keyboard interaction
- [ ] Recordings under ~0.5 s are discarded as accidental taps, with a short hint
- [ ] A visible recording indicator with elapsed time is shown (reusing `formatElapsedTime()` and the existing pulse style), and the state is announced through the `#voice-memo-status` live region
- [ ] The memo goes through the existing encrypted upload path (`startAttachmentUpload()` → `encryptAttachmentFile()`) and is sent only after the upload finishes
- [ ] The PWA allows sending with empty text when at least one attachment is present; the textarea is no longer `required`, and its validation moves into the submit handler
- [ ] The Worker's message validation (`worker/index.js`, `Field "text" must be a non-empty string`) accepts an empty or missing `text` when `attachments` is non-empty, with Worker tests for both the allowed and still-rejected cases
- [ ] The existing drawer record/preview/attach flow keeps working for users who want to review a memo before sending
- [ ] `MAX_VOICE_MEMO_DURATION_MS` still applies; hitting it auto-sends

## Implementation Notes (Optional)

**Files to modify:** `src/scripts/app.js`, `src/index.html`,
`src/assets/styles.css`, `worker/index.js`, `worker/index.test.js`

- Reuse `startVoiceMemoRecording()`, `stopVoiceMemoRecording()`, and
  `createVoiceMemoFile()`; the new part is the gesture handling plus an
  "auto-attach and send on stop" mode.
- Under schema v2, `text` is encrypted, so an empty plaintext still produces
  ciphertext. Decide whether the PWA omits `text` entirely for voice-only
  messages (cleaner) or sends encrypted empty text, and make the Worker and
  bot agree. The bot's `read_message_text(payload, required=False)` already
  handles a missing value.
- Mic permission prompts on first press; handle denial with the existing
  `handleVoiceMemoPermissionError()`.
- `touch-action: none` and `user-select: none` on the button prevent iOS
  long-press callouts from interrupting the hold.
