# feat: Guard PWA Polling with Page Visibility API

## What do you want to build?

Update the PWA polling loop in `src/scripts/app.js` to pause polling when the
browser tab is hidden (backgrounded) and resume immediately when the tab
becomes visible again. Currently, the `setTimeout`-based poll loop continues
firing in background tabs. Browsers throttle background timers to ~1-minute
intervals, which causes delayed response detection and wastes the Worker's
per-IP rate limit budget. Using the Page Visibility API ensures polling only
runs when the user is actively viewing the tab.

## Acceptance Criteria

- [ ] `src/scripts/app.js` adds a `visibilitychange` event listener on `document`
- [ ] When `document.hidden` becomes `true`, the polling timer is cleared and no new poll requests are made
- [ ] When `document.hidden` becomes `false` and there are pending conversations, polling resumes immediately with a fresh timer
- [ ] The offline queue drain logic is not affected — messages are still queued while the tab is hidden and drained when visible + online
- [ ] If no pending conversations exist when the tab becomes visible, polling is not started unnecessarily
- [ ] The change does not affect the initial polling behavior when the tab is first opened (already visible)
- [ ] Manual testing confirms: send a message, background the tab, wait 30+ seconds, foreground the tab — response appears within one poll interval of foregrounding
- [ ] No new dependencies are added (Page Visibility API is available in all modern browsers)

## Implementation Notes (Optional)

**Implementation pattern:**

```javascript
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(state.pollTimer);
    state.pollTimer = 0;
  } else if (state.pendingConversations.size > 0) {
    schedulePollCycle(elements, state);
  }
});
```

**File to modify:** `src/scripts/app.js`

Add the `visibilitychange` listener inside `initChatApp()` after the initial
setup. The polling schedule/clear functions already exist; this change only
adds the visibility guard.
