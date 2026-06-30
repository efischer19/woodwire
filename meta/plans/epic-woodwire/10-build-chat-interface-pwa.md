# feat: Build Chat Interface Shell as a Progressive Web App

## What do you want to build?

Build the Woodwire PWA frontend — a semantic, accessible, mobile-first chat
interface served as static HTML/CSS/JS. This is the user-facing portal for
sending messages and viewing AI responses. It must be installable as a PWA
with offline capability via a service worker.

## Acceptance Criteria

- [ ] `src/index.html` is redesigned as a chat interface with: a message input area, a send button, and a scrollable message history display
- [ ] The chat UI uses semantic HTML (`<main>`, `<form>`, `<article>` for messages, `<time>` for timestamps)
- [ ] The UI is fully responsive (mobile-first) and usable on screens from 320px to 1440px wide
- [ ] The UI meets WCAG 2.1 AA accessibility standards: keyboard navigable, screen-reader friendly, 4.5:1 contrast ratios
- [ ] Dark mode toggle is preserved from the template and works with the chat UI
- [ ] A `manifest.json` is created with app name, icons, theme color, and `display: standalone`
- [ ] A service worker (`sw.js`) is registered that caches the app shell (HTML, CSS, JS) for offline access
- [ ] The PWA is installable on mobile and desktop browsers
- [ ] When offline, the PWA displays a clear "You are offline" indicator and queues outgoing messages for later delivery
- [ ] The PWA stores the passphrase in `localStorage` (entered once by the user) and includes it in all Worker requests
- [ ] All existing linting checks pass (`htmlhint`, `markdownlint`, `pre-commit`)

## Implementation Notes (Optional)

**No frameworks.** Per the project's development philosophy, this is vanilla
HTML/CSS/JS. No React, Vue, or build tools.

**Chat UI layout suggestion:**

```text
┌─────────────────────────┐
│  Woodwire        [🌙]   │  ← header with dark mode toggle
├─────────────────────────┤
│                         │
│  [AI] Hello! How can    │  ← scrollable message area
│       I help?           │
│                         │
│           [You] Hi! ──► │
│                         │
├─────────────────────────┤
│  [📎] [🎤] [Type...]  [→] │  ← input area (attach, mic, text, send)
└─────────────────────────┘
```

**Service worker strategy:** Use a "cache-first, network-fallback" strategy
for the app shell (HTML, CSS, JS, icons). API requests should always go to the
network (the Worker), never be served from cache.

**Passphrase storage:** Store the passphrase in `localStorage` under a key
like `woodwire_auth`. The first time the user opens the app, show a setup
screen prompting for the passphrase. The passphrase is sent as the
`X-Woodwire-Auth` header on all Worker requests.

**Offline message queue:** When the network is unavailable, push outgoing
messages to a `localStorage` queue. On reconnect, drain the queue in order.

**PWA icons:** A simple favicon/icon is sufficient for this ticket. Polished
branding is a future concern.
