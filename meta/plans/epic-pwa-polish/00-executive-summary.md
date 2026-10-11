# PWA Polish — Executive Summary

## Executive Summary

Woodwire is working end to end: text, attachments, and voice memos flow from
the PWA through the Worker and SQS to the local bot and back. The next step is
making it nicer to use every day. This epic covers small frontend changes that
need no changes to the infrastructure or the message format.

All of these tickets touch `src/scripts/app.js`, `src/index.html`, and
`src/assets/styles.css`. They must keep the no-build-step frontend (vanilla
HTML/CSS/JS, deployable as-is) and the accessibility conventions documented in
`src/README.md`.

## Gap Analysis Breakdown

- **Assistant replies are rendered as plain text**: `appendMessage()` sets
  `textContent` on a single `<p>`, so Markdown from the LLM (lists, code
  blocks, emphasis) shows up as raw syntax.
- **No keyboard send shortcut**: the composer textarea has no `keydown`
  handling, so you have to click Send.
- **No per-message actions**: replies can't be copied with one click, and
  messages that fail or time out can't be retried.
- **Conversations can't be deleted or exported**: the sidebar supports create
  and rename only. All history lives in `localStorage` with no backup path.
- **No signal when a reply lands in the background**: replies are asynchronous,
  but the user only finds out if they're looking at the tab.

The bot's processing state ("Bot is replying…") is already shown using the
`processing.json` marker, so it is not in scope here.

## Ticket Sequence

| # | Ticket | Priority |
| :--- | :--- | :--- |
| 01 | Render assistant replies as sanitized Markdown | High |
| 02 | Send with Enter, newline with Shift+Enter | High |
| 03 | Add copy and retry actions to messages | Medium |
| 04 | Delete and export saved conversations | Medium |
| 05 | Notify when a reply arrives while the tab is hidden | Low |
