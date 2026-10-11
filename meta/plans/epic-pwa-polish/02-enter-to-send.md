# feat: Send with Enter, Newline with Shift+Enter

## What do you want to build?

Add the standard chat keyboard shortcut to the composer: pressing Enter in
`#message-input` sends the message, and Shift+Enter inserts a newline. Today
the textarea has no `keydown` handling, so sending always needs a click or tap
on the Send button.

## Acceptance Criteria

- [ ] Pressing Enter (no modifiers) in `#message-input` submits the composer form, going through the existing `submit` handler and all of its validation
- [ ] Shift+Enter inserts a newline as it does today
- [ ] Enter does nothing special during IME composition (`event.isComposing` or `keyCode === 229`), so CJK input methods still work
- [ ] On touch devices with no hardware keyboard (`matchMedia("(pointer: coarse)")`), Enter keeps inserting a newline and Send stays a tap
- [ ] Uses `form.requestSubmit()` so native validation and the `submit` listener both run
- [ ] The composer hint text or placeholder mentions the shortcut on devices where it applies
- [ ] No regression to the existing button-based send flow

## Implementation Notes (Optional)

**File to modify:** `src/scripts/app.js` (inside `initChatApp()`, next to the
existing `elements.composer` submit listener)

```javascript
elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }
  if (window.matchMedia("(pointer: coarse)").matches) {
    return;
  }
  event.preventDefault();
  elements.composer.requestSubmit();
});
```
