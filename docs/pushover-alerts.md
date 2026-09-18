# Pushover alerts

Pushover outage and hardware threshold alerts use emergency priority (`priority=2`), including recurring reminders. Pushover repeats each notification every 60 seconds until it is acknowledged, for up to 30 minutes (`retry=60`, `expire=1800`). These are server-side defaults for every Pushover channel; no environment variables or notification edits are required.

Recovery and test notifications use normal priority. Emergency repeats are handled by Pushover and stop on acknowledgement or expiry. A recovery notification does not cancel an earlier emergency notification. Acknowledging a Pushover notification does not stop Checkmate's separately configured recurring reminders; a later reminder creates a new emergency notification if the problem continues.

Monitor failure thresholds, geographic failure details, maintenance suppression, and reminder schedules are unchanged. This change does not add receipt tracking or callbacks.

See the [Pushover priority API documentation](https://pushover.net/api#priority) for acknowledgement and retry behavior.
