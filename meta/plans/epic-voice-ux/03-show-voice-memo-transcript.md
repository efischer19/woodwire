# feat: Show the Voice Memo Transcript on the User's Message

## What do you want to build?

When the bot transcribes a user's voice memo with faster-whisper, return that
transcript to the PWA and show it on the user's own message bubble, labeled
as what the bot heard. Today the transcript is merged into the AI prompt by
`combine_message_text()` in `bot/main.py` and thrown away, so when the bot
answers strangely the user can't tell whether Whisper misheard.

## Acceptance Criteria

- [ ] When `transcribe_audio_attachments()` returns a transcript, the bot writes it to S3 next to the reply as `outbox/{conversationId}/{timestamp}-response.input.txt`, using the same `{timestamp}-response` prefix as the `.md` / `.mp3` it belongs with
- [ ] The input transcript is encrypted with `encrypt_payload_bytes()` whenever the reply is encrypted (schema v2), same as the `.md` reply
- [ ] The Worker's `describeResponseFiles()` / `describeResponseFile()` recognize the `.input.txt` suffix as a separate `inputTranscript` kind. It must not be mistaken for the `.md` reply transcript or count as completion on its own
- [ ] The Worker response endpoint (the handler returning `audioUrl` / `transcriptUrl`) also returns a presigned `inputTranscriptUrl`, or `null` when absent
- [ ] The PWA fetches and decrypts the input transcript in `appendAssistantReply()` and attaches it to the original user message (matched by `localId` / `responseFor`), shown as a muted "Heard: …" line under the voice memo attachment
- [ ] The transcript is saved with the user message in `localStorage`, so it survives reload
- [ ] Older bot versions that don't write `.input.txt` keep working: the field is just absent
- [ ] Bot unit tests cover writing (and encrypting) the input transcript; Worker tests cover grouping `.input.txt` with its response and the `null` case

## Implementation Notes (Optional)

**Files to modify:** `bot/main.py`, `bot/tests/test_main.py`,
`worker/index.js`, `worker/index.test.js`, `src/scripts/app.js`,
`src/assets/styles.css`

- `build_backend_message()` currently returns
  `(prompt_text, voice_response_enabled)`. Return the raw transcript too, or
  put it on `ProcessedPayload`, so `write_response()` can store it.
- `describeResponseFile()` matches by extension with `endsWith`. Check
  `.input.txt` before the generic extensions, and make sure the
  `responseId` it strips matches the `.md` / `.mp3` siblings.
- Only one memo per message is the common case; if several audio attachments
  are transcribed, store the joined transcript (already joined with blank
  lines) as-is.
- Text over SQS → S3 stays inside the existing E2EE boundary; the Worker only
  ever handles ciphertext and presigned URLs.
