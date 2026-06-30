# feat: Add Media Upload to PWA via Pre-signed URLs

## What do you want to build?

Extend the PWA (from Tickets 10–11) with the ability to upload images and files
alongside text messages. The PWA requests a pre-signed S3 PUT URL from the
Worker (Ticket 07), uploads the file directly to S3, and includes the S3 key
in the message payload sent to the Worker.

## Acceptance Criteria

- [ ] The PWA chat input area includes an attachment button (📎) that opens a file picker
- [ ] The file picker accepts images (`image/*`), PDFs (`application/pdf`), and text files (`text/*`)
- [ ] Files exceeding 25 MB are rejected client-side with a user-friendly error message
- [ ] On file selection, the PWA requests a pre-signed upload URL from `POST /api/upload-url`
- [ ] The PWA uploads the file directly to S3 using the pre-signed PUT URL with the correct `Content-Type` header
- [ ] A progress indicator shows upload progress (using `XMLHttpRequest` or `fetch` with progress events)
- [ ] After a successful upload, the S3 key is included in the message payload's `attachments` array when the user sends the message
- [ ] Multiple files can be attached to a single message (up to 5 files)
- [ ] Attached files display as thumbnails (for images) or file names (for other types) in the input area before sending
- [ ] Attached files are removable before sending (click to remove)
- [ ] The chat history displays sent attachments as clickable links or inline image previews

## Implementation Notes (Optional)

**Upload flow:**

1. User clicks 📎 → file picker opens
2. User selects file(s)
3. For each file:
   a. Validate size (< 25 MB) and type
   b. Call `POST /api/upload-url` with `{ "filename": "photo.jpg", "contentType": "image/jpeg" }`
   c. Receive `{ "uploadUrl": "...", "key": "attachments/..." }`
   d. `PUT` the file to the uploadUrl with `Content-Type` header
   e. Store the S3 `key` in a pending attachments array
4. User types a message and clicks send
5. Message payload includes `"attachments": ["attachments/uuid/photo.jpg"]`

**Image thumbnail preview:** Use `FileReader.readAsDataURL()` to generate a
local preview before uploading. This provides instant visual feedback.

**Progress tracking:** Use `XMLHttpRequest` with an `upload.onprogress` event
handler for upload progress, as `fetch()` does not natively support upload
progress tracking.

**Accessibility:** The file picker button must have an `aria-label`
("Attach a file"). File previews must include `alt` text. Progress indicators
must be announced to screen readers (`aria-live="polite"`).
