# feat: Delete and Export Saved Conversations

## What do you want to build?

Let users manage the "Saved conversations" sidebar in the PWA:

- **Delete** a conversation, removing its messages and metadata from this
  browser.
- **Export** a conversation, or all of them, as a downloadable file so history
  can be backed up or moved to another device.

Today the sidebar supports only New, select, and rename
(`renameConversation()`). History lives in `localStorage` under
`STORAGE_KEYS.history` and `STORAGE_KEYS.conversations` and grows forever.

## Acceptance Criteria

- [ ] Each conversation in `#conversation-list` has a delete control that asks for confirmation before deleting
- [ ] Deleting removes the conversation's entry from `STORAGE_KEYS.conversations`, its messages from `STORAGE_KEYS.history`, and any matching entries from `STORAGE_KEYS.queue` and `STORAGE_KEYS.pendingConversations`
- [ ] Deleting the active conversation switches to the most recent remaining conversation, or to a fresh empty state if none remain
- [ ] Deleting only affects local browser storage; no Worker or S3 calls (S3 lifecycle rules already expire server-side data)
- [ ] An Export action downloads the selected conversation as Markdown (`.md`), with author, timestamp, and text for each message and attachment names listed (not attachment contents)
- [ ] An "Export all" action downloads every conversation as one JSON file whose format can be read back by a later import feature (import itself is out of scope)
- [ ] Exports contain decrypted text as shown in the UI and never include the passphrase or E2EE key
- [ ] All new controls are keyboard-accessible with descriptive `aria-label`s (e.g. "Delete conversation: <name>")

## Implementation Notes (Optional)

**Files to modify:** `src/scripts/app.js`, `src/index.html`,
`src/assets/styles.css`

- `renderConversationList()` builds the sidebar items; add per-item actions
  there and reuse the existing `elements.conversationList` click delegation.
- Relevant helpers: `getStoredMessages()` / `setStoredMessages()`,
  `getStoredConversations()` / `syncStoredConversations()`,
  `getQueuedMessages()` / `setQueuedMessages()`, `getPendingConversations()`,
  `setActiveConversationId()`.
- Download via `URL.createObjectURL(new Blob([...]))` and a temporary
  `<a download>`; revoke the object URL afterward.
- Use `window.confirm()` for confirmation to start with; a custom dialog can
  come later.
