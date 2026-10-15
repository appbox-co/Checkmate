# Push (heartbeat) monitors

A push monitor alerts when a system stops reporting in. Instead of Checkmate checking a target, the monitored system calls a unique push URL. The monitor goes down when no push arrives within its grace period. Use it as a dead man's switch, for example for Alertmanager's always-firing Watchdog alert or for cron jobs.

## Setting one up

1. **Uptime → Create**, type **Heartbeat**. Choose a name, the **grace period** (1 minute to 24 hours, default 5 minutes) and the **check frequency**. The check frequency controls how often Checkmate compares the last push with the grace period.
2. Save. The configuration page then shows the push URL, the time of the last push, **Copy URL** and **Regenerate URL**. Regenerating replaces the URL immediately; the previous URL stops working.

New heartbeat monitors default to an incident window of one check at 100%, so the first evaluation after the grace period opens the incident. A larger window delays the alert by further check intervals.

## Calling the push URL

```
GET|HEAD|POST|PUT /api/v1/push/<token>
```

Any request body is accepted and ignored, so Alertmanager can call the URL directly from a `webhook_configs` receiver (JSON POST, a few KB). A recorded push returns `200 {"success":true,"msg":"Push recorded"}`; an unknown or malformed token returns 404. The token is a 43-character base64url value with 256 bits of entropy and is the only credential. Treat the URL as a secret.

Example Alertmanager receiver for the Watchdog alert:

```yaml
route:
  routes:
    - matchers: [alertname = "Watchdog"]
      receiver: checkmate-heartbeat
      group_wait: 0s
      group_interval: 1m
      repeat_interval: 1m
receivers:
  - name: checkmate-heartbeat
    webhook_configs:
      - url: https://status.example.com/api/v1/push/<token>
        send_resolved: false
```

## Behaviour

- Silence is measured from the last push, or from creation for a monitor that has never received one ("Waiting for the first push").
- After a Checkmate restart, silence is measured from the restart unless the monitor is already down, so downtime of Checkmate itself cannot raise a false alert. An existing outage still needs a real push to recover.
- Pushes are recorded while a monitor is paused or in maintenance; those states suppress evaluation and alerts as for other monitor types.
- Recovery happens on the first evaluation after a push. Incidents, notification channels, reminders and maintenance windows work as for other monitors.
- Heartbeat monitors have no target address. Their URL field shows `push`; the token never appears in notifications, lists or public status pages. Exports omit the token, and every imported heartbeat monitor receives a new one.

## Push URL host

The dashboard builds the URL from `CLIENT_CONFIG_PUSH_BASE_URL` when set, otherwise from the address the dashboard is opened at. Set it when administrators reach Checkmate through a tunnel or private address. The Appbox deployment uses `https://status.appbox.co`; Nginx on the public status host forwards `/api/v1/push/<token>` with a 64 KB body limit and no caching. See [Public status page deployment](public-status-deployment.md).
