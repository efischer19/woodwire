# Voice UX — Executive Summary

## Executive Summary

Woodwire already has a complete local voice loop. The PWA records voice memos
with `MediaRecorder` and encrypts and uploads them. The bot transcribes them
with faster-whisper (`bot/voice.py`), sends the transcript to the AI backend,
synthesizes the reply with Piper, and stores an `.mp3` next to the text reply.
The PWA then plays it back, with optional autoplay.

What's missing is a quick way to use it. Sending a voice message takes about
five steps (open drawer, record, stop, attach, type something, send), only
voice input gets a spoken reply, and the user never sees what Whisper heard.
This epic makes voice a first-class way to talk to the bot, in the spirit of
Woodwire's "cabin telephone" idea.

## Gap Analysis Breakdown

- **Voice memos require typed text**: the composer `submit` handler returns
  early when `#message-input` is empty (`src/scripts/app.js`), and the Worker
  rejects empty `text` (`worker/index.js`, `Field "text" must be a non-empty
  string`). The bot already accepts attachment-only messages
  (`read_message_text(..., required=False)`).
- **Too many steps to talk**: recording lives in the attachment drawer and
  needs separate stop, attach, and send actions.
- **Text replies can't be heard**: `build_response_audio()` in `bot/main.py`
  only synthesizes speech when the incoming message had an audio attachment.
- **The STT transcript isn't shown**: Whisper's transcript is merged into the
  prompt by `combine_message_text()` and never returned to the PWA, so a
  mis-hearing is invisible.

## Ticket Sequence

| # | Ticket | Priority |
| :--- | :--- | :--- |
| 01 | Hold-to-talk voice messages | High |
| 02 | Read text replies aloud | Medium |
| 03 | Show the voice memo transcript on the user's message | Medium |
