# feat: Add Voice Memo Recording to PWA

## What do you want to build?

Extend the PWA with the ability to record voice memos using the browser's
native Web Audio API and upload them to S3 as compressed audio files. Voice
memos are treated as attachments — they are uploaded via the same pre-signed
URL flow (Ticket 07/12) and referenced in the message payload.

## Acceptance Criteria

- [ ] The chat input area includes a microphone button (🎤) for voice recording
- [ ] Pressing the microphone button requests microphone permission via `navigator.mediaDevices.getUserMedia()`
- [ ] If permission is denied, a user-friendly message explains how to grant it
- [ ] Recording uses the `MediaRecorder` API to capture audio in `.webm` (Opus codec) format
- [ ] A "hold to record" or "tap to start/stop" interaction pattern is implemented (with clear visual feedback)
- [ ] During recording, a visual indicator shows elapsed time and a waveform or pulsing animation
- [ ] A maximum recording duration of 5 minutes is enforced (auto-stop with notification)
- [ ] After recording, the user can preview the audio (play/pause), re-record, or confirm and attach
- [ ] On confirmation, the audio file is uploaded to S3 via a pre-signed URL (reusing the flow from Ticket 12)
- [ ] The voice memo appears in the chat as an inline audio player after sending
- [ ] The microphone button is hidden (graceful degradation) if the browser does not support `MediaRecorder`

## Implementation Notes (Optional)

**MediaRecorder usage:**

```javascript
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
const chunks = [];
recorder.ondataavailable = (e) => chunks.push(e.data);
recorder.onstop = () => {
  const blob = new Blob(chunks, { type: 'audio/webm' });
  // Preview or upload
};
```

**Codec selection:** Prefer `audio/webm;codecs=opus` for compression
efficiency (typical voice memo: ~12 KB/second). Fall back to `audio/webm` if
Opus is not supported. Safari may require `audio/mp4` — detect and adapt.

**File size estimation:** A 5-minute voice memo at Opus quality is ~3.5 MB,
well within the 25 MB upload limit.

**Accessibility:**

- The microphone button must have `aria-label="Record voice memo"`
- Recording state must be announced: `aria-live="assertive"` for start/stop
- The audio preview must use a native `<audio>` element with controls
- Keyboard users must be able to start/stop recording with Enter or Space

**Progressive enhancement:** The microphone button is only rendered if
`navigator.mediaDevices` and `MediaRecorder` are available. On unsupported
browsers, the button is absent rather than broken.
