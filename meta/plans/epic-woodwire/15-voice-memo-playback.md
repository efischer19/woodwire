# feat: Add Voice Memo Playback and Transcript Display to PWA

## What do you want to build?

Extend the PWA (from Tickets 10–13) to detect and play audio responses from
the AI. When the bot responds with both a text transcript and an audio file,
the PWA displays the transcript and renders an inline audio player. This
completes the voice memo round-trip.

## Acceptance Criteria

- [ ] The PWA's response polling (from Ticket 11) detects when a response includes both `.md` (transcript) and `.mp3` (audio) files in the outbox
- [ ] The text transcript is displayed as a regular chat message
- [ ] An inline `<audio>` player is rendered below the transcript with standard playback controls (play, pause, seek, volume)
- [ ] The audio file is loaded via a pre-signed GET URL from the Worker (not directly from S3)
- [ ] If only a text transcript is available (no audio), only the text is displayed (graceful degradation)
- [ ] If only audio is available (no transcript), the audio player is displayed with a note: "Voice response — no transcript available"
- [ ] The audio player is keyboard accessible and screen-reader friendly
- [ ] Auto-play is disabled by default (respects browser autoplay policies) but can be enabled via a PWA setting
- [ ] A "downloading audio..." indicator is shown while the audio file loads
- [ ] The audio player works on all major browsers (Chrome, Firefox, Safari, Edge) and mobile platforms

## Implementation Notes (Optional)

**Response detection flow:**

1. `GET /api/status/:conversationId` returns `"complete"` with metadata:
   `{ "status": "complete", "hasAudio": true, "hasTranscript": true }`
2. `GET /api/response/:conversationId` returns:
   `{ "transcript": "...", "audioUrl": "https://presigned-s3-url/response.mp3" }`
3. The PWA renders the transcript as text and the audioUrl in an `<audio>` tag.

**Audio player markup:**

```html
<div class="voice-response" role="region" aria-label="Voice response">
  <p class="transcript">AI response text here...</p>
  <audio controls preload="metadata">
    <source src="presigned-url.mp3" type="audio/mpeg">
    Your browser does not support audio playback.
  </audio>
</div>
```

**Browser compatibility:** `.mp3` (MPEG Audio) is universally supported across
all modern browsers. The bot generates `.mp3` specifically for this reason
(Ticket 14).

**Auto-play setting:** Store the user's preference in `localStorage` under
`woodwire_autoplay`. If enabled, call `audio.play()` after loading, wrapped
in a try-catch to handle browsers that block autoplay without user gesture.

**Accessibility:**

- The audio player must be focusable and operable via keyboard
- The transcript serves as an accessible alternative to the audio
- Use `aria-label` on the audio element: "AI voice response"
