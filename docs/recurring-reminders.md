# Recurring notification reminders

In a monitor's **Notifications** settings, select **Repeat reminders**. The available intervals are 5, 15 or 30 minutes, and 1, 3, 6, 12 or 24 hours. **Disabled** is the default for existing and new monitors. The same interval applies to every channel selected on that monitor.

The first outage/threshold alert and the recovery alert keep their existing behaviour. While a monitor remains down or exceeds hardware thresholds, reminders are sent on the next evaluated check at or after the interval. Reminders do not create additional incidents. Paused monitors and maintenance windows suppress reminders.

The next reminder deadline is saved in MongoDB. Restarting a worker preserves it; missed intervals produce at most one reminder, rather than a backlog of messages. Delivery reserves the next deadline atomically before contacting providers, so overlapping evaluations cannot send the same reminder. The notification includes `reminder` as its reason and a `Reminder:` title.

The deadline advances for an attempted reminder even if a provider fails, preventing a failure from retrying on every check or repeatedly notifying successful channels. A process crash after reservation can lose that attempt; the next interval is still eligible. This is not a guaranteed-delivery queue. Recurring reminders depend on checks continuing to be evaluated.

Changing the interval starts a new interval from the time it is saved; saving unrelated fields preserves the deadline. Recovery clears the outage schedule, and a subsequent outage starts a fresh interval. JSON export/import preserves the interval but does not copy runtime deadlines or notification-channel assignments.

API field: `notificationReminderInterval` (milliseconds), one of `0`, `300000`, `900000`, `1800000`, `3600000`, `10800000`, `21600000`, `43200000`, `86400000`. `nextNotificationReminderAt` is a server-managed epoch-millisecond deadline. Existing documents without these fields remain disabled, so no data backfill is required. The server and client changes must be deployed together before enabling reminders.
