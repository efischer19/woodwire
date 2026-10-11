# feat: Render Assistant Replies as Sanitized Markdown

## What do you want to build?

Render assistant replies in the PWA as formatted Markdown instead of plain
text. The bot stores replies as `text/markdown` (`bot/main.py`
`write_response()`), and LLM output often contains lists, headings, code
blocks, links, and emphasis. Today `appendMessage()` in `src/scripts/app.js`
puts the whole reply into a single `<p>` with `textContent`, so all of that
appears as raw `**`, `#`, and backtick characters.

User messages should stay plain text.

## Acceptance Criteria

- [ ] Assistant messages (`variant: "assistant"`) render Markdown: paragraphs, headings, ordered/unordered lists, inline code, fenced code blocks, links, bold/italic, and blockquotes
- [ ] User messages keep rendering as plain text via `textContent`
- [ ] Rendered HTML is sanitized: no `<script>`, inline event handlers, `javascript:` URLs, `<iframe>`, `<style>`, or raw HTML passthrough from the model output
- [ ] Links open in a new tab with `rel="noopener noreferrer"`
- [ ] Fenced code blocks use a monospace style that scrolls horizontally instead of overflowing the message bubble, in both light and dark themes
- [ ] Any third-party library is vendored into `src/` (no CDN, no build step) and added to `APP_SHELL_ASSETS` in `src/sw.js`, with `APP_SHELL_CACHE` bumped so existing installs pick it up
- [ ] Stored history in `localStorage` keeps the raw Markdown text; rendering happens at display time
- [ ] Unit or manual test notes cover a reply containing `<img src=x onerror=alert(1)>` and `[x](javascript:alert(1))`, and both render inert

## Implementation Notes (Optional)

**Files to modify:** `src/scripts/app.js`, `src/assets/styles.css`, `src/sw.js`

Two reasonable approaches:

1. **Vendored library**: e.g. `marked` (ESM build) plus `DOMPurify`, both
   copied into `src/scripts/vendor/` with their licenses. Most complete, about
   60 KB total.
2. **Small in-house renderer**: build DOM nodes directly
   (`document.createElement`) for a limited subset of Markdown. No HTML strings
   means no sanitizer is needed, but it's more code to maintain.

Prefer option 2 if it stays under ~200 lines; otherwise use option 1. Either
way, the branch in `appendMessage()` around `text.textContent = message.text`
is where the assistant/user split goes.

`app.js` is currently a single classic script. If you add ES module vendor
files, either load them with a separate `<script type="module">` that exposes
a function on `window`, or wait for the planned split of `app.js` into ES
modules.
