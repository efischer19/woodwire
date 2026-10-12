# Household chief of staff: multi-user roadmap

**Status:** Research / roadmap. Nothing here is implemented yet.
**Created:** 2026-10-12

## Context

Woodwire is single-user today. Cloudflare Access only lets in one Gmail address, and
everything behind it assumes one person. The long-term goal is a household chief of
staff: an agent that coordinates across household members, so it has to talk to all
of them.

This doc covers:

- what it takes to add a second member (a spouse)
- whether the agent can tell members apart
- how a shared group thread would work
- which features a shared chief of staff will eventually need

## Decisions so far

| Date | Decision |
| :--- | :--- |
| 2026-10-12 | **No privacy between household members.** It's one household sharing one pipeline. Document this in the README/threat model instead of building per-user isolation. |
| 2026-10-12 | **In a group thread, the bot decides when to reply.** It reads every message and replies only when useful. An @mention always gets a reply. |

## Current state: one user, no identity

- **Letting a second person in is easy.** Add their email to the Access policy and give
  them the same passphrase and E2EE key. It works in minutes.
- **The agent can't tell who's talking.** Nothing about identity makes it past the
  Worker:
  - `worker/index.js` `isAuthorized()` checks one shared secret (`X-Woodwire-Auth`).
  - `handleMessageRequest()` builds the SQS payload from `{schemaVersion, attachments,
    conversationId, createdAt, text}`. It has no sender field.
  - `bot/main.py` and `bot/ai_backend.py` `OpenClawBackend.process()` send OpenClaw only
    the text and `X-OpenClaw-Session-Key: <conversationId>`.
- **Access already knows who's who.** Access protects the whole hostname, `/api/*`
  included (see commit 5898cc8). So every request that reaches the Worker carries a
  signed `Cf-Access-Jwt-Assertion` header with the user's email. The Worker just
  ignores it today.

## What's harder than it looks (by cost)

1. **Attribution (small, about 1 PR).** The Worker verifies the Access JWT, maps the
   email to a household member, and adds `sender` to the payload on the server side.
   The bot passes it to OpenClaw. See Phase 1.
2. **Privacy between members (medium, decided against).** Today's isolation comes from
   unguessable UUIDs, not enforcement:
   - The status, response and attachment endpoints serve any valid ID to any signed-in
     caller.
   - `/api/message` accepts a conversation ID from the client.
   - There is one shared E2EE key.

   Per the 2026-10-12 decision, document this instead of fixing it.
3. **Agent-initiated messages (the real architectural gap).** Woodwire is strictly
   request/response: the PWA polls only conversations it started. A chief of staff
   needs to say "tell [spouse] the plumber is coming Thursday." Open question: should
   this be an in-app inbox, email, SMS, push, or some mix? See Phase 3.
4. **Agent-side memory model (outside Woodwire).** OpenClaw sessions are keyed per
   conversation. A household agent needs per-person context, shared household memory,
   and "don't volunteer this" rules (e.g. gift planning). This is OpenClaw config and
   prompt design, not Woodwire code.

## Phase 1: identity plumbing (do first)

### Worker (`worker/index.js`)

- Add `verifyAccessJwt(request, env)`:
  - Read `Cf-Access-Jwt-Assertion`.
  - Fetch the JWKS from `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` and
    cache it in module scope, like `RATE_LIMIT_STORE`.
  - Verify RS256 with `crypto.subtle`, and check `aud === env.ACCESS_AUD`, `exp` and
    `iss`.
  - No new dependency. aws4fetch is already vendored, and this fits that style.
- Add a `WOODWIRE_USERS` env var: a JSON map from email to a stable user id. Return 403
  for any email that isn't listed. This is defense in depth if the Access policy drifts.
- In `handleMessageRequest()`, add `sender: <userId>` to the payload. Always derive it
  on the server and ignore any `sender` the client sends.
- Key `enforceRateLimit()` by user id instead of IP. Everyone at home shares one IP.
- Keep the `X-Woodwire-Auth` passphrase as a second factor for now. Whether to keep it
  long term is a separate decision.
- New env/secrets: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `WOODWIRE_USERS`. Document them
  in `worker/README.md` and `QUICK_START.md`, and wire them in
  `.github/workflows/deploy-worker.yml`.

### Bot (`bot/main.py`, `bot/ai_backend.py`)

- Add `read_sender(payload)`. It's optional and defaults to `None` for old messages.
  Add `senderId` to the `JsonFormatter` extras.
- Extend `AIBackend.process()` with `sender: str | None`.
- In `OpenClawBackend`, send the sender two ways: as a header (`X-Woodwire-Sender`) and
  as a short prefix on the input text (`[From: eric]`). That way the model sees it no
  matter what OpenClaw does with headers. If OpenClaw has a native user/session-scoping
  field, prefer that.
- Make `MockBackend` echo the sender, for easy manual testing.

### PWA

No changes needed. Each person's device keeps its own localStorage history.

### Verification

- `cd worker && npx vitest run`. Cover:
  - a valid JWT (sender is stamped)
  - a bad signature
  - the wrong `aud`
  - an expired token
  - an email that isn't in `WOODWIRE_USERS` (403)
  - a client-supplied `sender` (overwritten)
- `cd bot && uv run pytest`. Check that:
  - the sender is read
  - it defaults to None for old payloads
  - it's forwarded to OpenClaw in both the header and the prefix
- End to end:
  1. Deploy.
  2. Add the spouse to the Access policy and to `WOODWIRE_USERS`.
  3. Run the bot with `AI_BACKEND=mock`.
  4. Send from both phones. The echoes and the JSON logs should show different `senderId`
     values.

## Phase 2: group thread (Eric + spouse + bot)

The group thread is kept separate from each person's one-on-one thread.

### Why it isn't free today

The PWA is built around "my message, then one bot reply":

- **Human messages are never stored on the server.** They pass through SQS and are
  deleted. Only bot replies land in S3 (`outbox/<conv>/`). A member's own messages
  exist only in their phone's localStorage, so nobody else can see them.
- **Polling is driven by replies** (`pollConversation` in `src/scripts/app.js`). The app
  polls only conversations with a pending message, fetches only the latest response, and
  gives up after 5 minutes. Nothing watches a thread for messages from other people.
- **Everything expires.** `inbox/`, `outbox/` and `attachments/` expire after 48h
  (`infra/woodwire-chat-bucket.yaml`). That's fine for chat, but a household log needs
  to last.
- **Order isn't guaranteed.** The SQS queue is standard, not FIFO, so two messages sent
  close together can reach the bot out of order.

### What already works

- **Separation from one-on-one threads is free.** A different `conversationId` means a
  different OpenClaw session.
- **The PWA already has a list of multiple conversations.**
- **The shared E2EE key fits the no-privacy decision.** Every device can decrypt the
  group log.

### Pieces needed (Phase 1 is a prerequisite)

1. **A shared thread ID.** Configure one well-known `household` thread on the server and
   pin it in the conversation list. No invite flow.
2. **A server-side message log** at `threads/household/<ts>-<sender>.json`, encrypted.
   - The Worker writes each human message on `/api/message`, so it shows up right away.
   - The bot writes its replies to the same prefix.
   - Give the new prefix a long expiration, or none.
3. **A sync endpoint:** `GET /api/thread/household?after=<key>`, using S3 ListObjectsV2
   `start-after`. The PWA polls it while the thread is open. Use a slower idle interval
   (10–15s) plus the Visibility API to stay inside the Cloudflare free tier.
4. **A PWA group view:**
   - name labels on messages from other people
   - merging in messages that came from other devices
   - deduping your own echoed messages
5. **Bot reply behavior** (decided: the bot decides):
   - The bot reads every message and replies only when useful.
   - When it stays quiet, OpenClaw returns a no-reply sentinel (e.g. `NO_REPLY`) and
     the bot writes nothing to the log. It still deletes the SQS message and clears
     `processing.json`, so the app never shows a permanent "Bot is replying…".
   - Prompt it with the participant list and guidance on when to stay quiet.
   - An @mention always gets a reply.
6. **Optional: a FIFO queue** (`MessageGroupId=household`) for strict ordering.

### Rough size

About 4 PRs after Phase 1:

1. Message log + sync endpoint (Worker + bot)
2. PWA group view
3. Group reply behavior in the bot
4. Infra: prefix lifecycle, optional FIFO

The PWA work is the largest. Do it after the `app.js` ES-module split.

Without push notifications (the background-notifications ticket), members only see new
group messages when the app is open.

## Phase 3: agent-initiated messages

- **In-app option:**
  - The bot writes to `inbox/<user>/<ts>.md`.
  - The Worker exposes `GET /api/inbox`, scoped to the caller.
  - The PWA polls it (or uses Web Push) and shows threads the agent started.
- **Outside-channel option:** email, SMS, etc. Still under consideration.
- **Either way,** give the agent a "send message to <member>" tool in OpenClaw.

## Feature backlog for a shared chief of staff

Most of sections 3–4 below depend on Phase 3's outreach channel. Section 2 is mostly
OpenClaw tools and connectors, and barely touches Woodwire.

1. **Knowing who's who** (builds on Phase 1)
   - **A profile for each person:** schedules, preferences, diet, how they like to be
     reached, who owns which area.
   - **Attribution and history:** "Eric added milk," "[spouse] approved the plumber
     quote."
   - **Roles, eventually:** kids, a babysitter or a visiting relative with limited or
     time-boxed access.
2. **Shared household state**
   - **Shared lists with assignees:** groceries, chores, errands, projects.
   - **Calendar:** read both calendars, flag conflicts, suggest times that work.
   - **A household reference book:** contractors, warranties, insurance, appliance
     models, the Wi-Fi password, vet and doctor contacts. Attachments make it easy to
     photograph a bill or warranty card.
   - **Recurring deadlines:** renewals, registrations, tax dates, school forms,
     maintenance.
3. **Coordination tools**
   - **Ask and wait:** "ask [spouse] if Saturday works." The agent tracks open
     questions, follows up, and reports back to whoever asked.
   - **Lightweight decisions:** a quick vote, or one person proposes and the other
     confirms.
   - **Handing off tasks:** reassign a task and get a confirmation back.
   - **Nudges that get firmer:** a gentle reminder, then a firmer one, then a heads-up
     to the other member.
4. **The agent speaking up first**
   - **A summary for each person:** a morning briefing and a weekly "here's the week."
   - **Proactive notices:** a schedule change, an expiring warranty.
   - **Channel by urgency and preference:** push for "now," email for digests.
5. **Guardrails**
   - **Approval before acting:** anything that commits another member, spends money, or
     contacts someone outside the household needs a yes from the right person.
   - **No silent acting on someone's behalf.** Commitments made for another member are
     confirmed with them, or at least announced to them.
   - **Discretion, separate from privacy:** a soft "don't bring this up" for surprises.
     It's an agent behavior rule, not a security guarantee.
6. **How conversations are organized**
   - A shared household thread next to each person's own threads (Phase 2).
   - Cross-thread awareness ("[spouse] mentioned the dentist is the 14th") needs
     household-wide memory in OpenClaw.

## Open questions

- Which outreach channel(s) should Phase 3 use: in-app inbox, email, SMS, push?
- Keep the `X-Woodwire-Auth` passphrase once Access JWT identity exists, or drop it?
- How should household-wide memory be structured in OpenClaw versus memory for each
  person?
