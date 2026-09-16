# Public status-page communications

## Staff updates and pinned announcements

Open **Status pages**, select a page, then choose **Manage updates**.

- Admins and super admins can publish, edit, pin, unpin and delete updates for their own team's pages.
- Each update has a title, plain-text message, status (Announcement, Investigating, Identified, Monitoring or Resolved), original author's display name, and publication/edit timestamps.
- Pinned messages appear above the service list. Other updates appear below it, newest first, with a button to show older updates.
- Updates on published pages are public immediately. Updates on unpublished pages remain available only to the owning team's authenticated preview.
- Post status is descriptive; it does not change monitor health, resolve monitoring incidents, or send notifications.
- Messages use escaped text with preserved line breaks. The existing API sanitizer removes HTML tags; Markdown is not interpreted.
- Titles are limited to 160 characters and messages to 5,000 characters. Each page retains up to 200 updates. At the limit, an admin must remove an older update; history is never silently discarded.

Updates are embedded in the existing status-page document, using atomic append, positional edit and removal operations. Concurrent posts do not replace each other. General page configuration cannot overwrite the update array or author metadata. The original author and creation timestamp stay unchanged on edits; the edit timestamp is server-generated. No author email is published.

## Public planned maintenance

Enabled maintenance windows automatically appear on each published status page containing an affected monitor. The maintenance form explains that the window name and schedule will be public.

- Visitors see the window name, start/end, scheduled/in-progress state, recurrence and affected services.
- Only services belonging to the page's team and selected on that page appear. Monitor targets and internal window metadata are omitted.
- Dates use the status page's configured timezone, including the displayed UTC offset.
- One-off windows disappear after their end. Disabled or deleted windows disappear on the next refresh.
- Recurring windows show their current or next occurrence. Existing recurrence is a fixed elapsed interval (24 hours or 7 days), not a local wall-clock/DST schedule.
- Maintenance remains current when visitors select historical uptime chart ranges.

The display reads the existing maintenance records. It does not create a new scheduler or change how maintenance suppresses checks and reminders. All five status-page themes share these components.

## API and compatibility

- `POST /api/v1/status-page/:id/updates` — publish `{ title, body, status, pinned }`.
- `PUT /api/v1/status-page/:id/updates/:updateId` — edit those same fields (including pin/unpin).
- `DELETE /api/v1/status-page/:id/updates/:updateId` — delete an update.
- Existing slug and custom-domain public responses include `statusPage.updates` and `maintenanceWindows`.

Mutation routes require an authenticated admin or super admin and enforce team ownership. Body validation rejects client-supplied author, identifier and timestamp fields. Existing pages read as having no updates; no database migration is required. The generated OpenAPI specification includes the routes and public fields.

## Validation

- Full backend regression suite: 96 suites, 1,793 tests passed.
- Integration tests use disposable MongoDB and local HTTP routes, covering publication, editing, pin/unpin, deletion, persistence, simultaneous posts, capacity, role/team access, unpublished pages, custom domains, general configuration, and public maintenance filtering.
- Maintenance unit tests cover one-off windows, inclusive boundaries, daily/weekly recurrence, DST, overlapping occurrences and invalid records.
- Backend and frontend production builds pass.
- Backend lint and changed frontend-file lint pass.
- Browser checks use a loopback-only sample instance with monitoring workers disabled and no production data. Publishing, editing, unpinning and the deletion confirmation were verified in the admin UI; all five public themes were checked at 390px width without horizontal overflow.
- The integration harness forwards DOMPurify to the real Node module loader to avoid Jest 30’s ESM loader incompatibility with Node 23; sanitization behavior is not stubbed.

This source change is separate from the previously deployed recurring-reminder release. Build and deploy a new image to make these controls available on the VPS.
