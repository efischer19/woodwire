# feat: Read Text Replies Aloud

## What do you want to build?

Add a "Read aloud" control to assistant replies that don't already have a bot
voice reply, so any reply can be heard. Today the bot only synthesizes speech
(Piper → `.mp3`) when the incoming message contained an audio attachment
(`build_response_audio()` in `bot/main.py`), so replies to typed messages are
text-only.

This ticket uses the browser's built-in Web Speech API
(`window.speechSynthesis`), which needs no backend, Worker, or storage
changes. Getting Piper audio on demand for any reply would need a new
request/response round trip and is out of scope.

## Acceptance Criteria

- [ ] Assistant messages without `voiceResponse.hasAudio` show a "Read aloud" button when `"speechSynthesis" in window`
- [ ] Clicking it speaks the reply text with `SpeechSynthesisUtterance`; while speaking, the button becomes "Stop" and stops playback when clicked
- [ ] Starting a new read-aloud cancels any utterance already playing (`speechSynthesis.cancel()`)
- [ ] Markdown syntax is stripped before speaking (no reading out "asterisk asterisk"); fenced code blocks are skipped or replaced with "code block omitted"
- [ ] Messages that already have a Piper voice reply keep the existing audio player and do not get the button
- [ ] Optional: a voice picker in Connection settings, filled from `speechSynthesis.getVoices()` (populate on `voiceschanged`) and stored in `localStorage`; the browser default is used otherwise
- [ ] Optional: when the existing "Auto-play AI voice replies" setting is on, text-only replies are spoken automatically using this path
- [ ] The button is keyboard-accessible, has `aria-pressed` reflecting speaking state, and works in light and dark themes

## Implementation Notes (Optional)

**Files to modify:** `src/scripts/app.js`, `src/assets/styles.css`, and
optionally `src/index.html` for the voice picker

- If ticket `epic-pwa-polish/03` (copy and retry) has landed, put this button
  in the same `.message-actions` container.
- Chrome stops long utterances after about 15 s on some platforms; splitting
  text into sentence-sized utterances and queueing them avoids this.
- Speech synthesis runs on the device; text is not sent anywhere, which fits
  the project's privacy stance. Note this in `src/README.md`.
