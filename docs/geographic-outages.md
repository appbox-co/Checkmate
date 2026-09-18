# Geographic outage detection

Enable **Geographic checks** in an HTTP or ping monitor's configuration and select regions and an interval. The existing switch controls probing and its effect on outages. Disabled monitors retain their existing local-only behavior.

## Outage and recovery

- Any conclusive failed probe in a selected continent marks the monitor **down** on the next normal evaluation. This bypasses the local failure-window threshold. Probe acquisition and the existing buffer/evaluator add latency; the production buffer normally flushes once a minute.
- Local and geographic observations enter the existing serialized per-monitor evaluation job. One combined status drives incidents, notifications, reminders, the dashboard and public status pages.
- Local checks keep their own failure window. Local success cannot clear an unresolved geographic failure. Geographic success cannot clear a local outage.
- A successful observation from each previously failing continent clears its geographic failure. Globalping selects a probe within each continent on each run; recovery confirms the continent, not necessarily the identical city or network.
- Missing regions, offline probes, rate limiting, API errors and incomplete/unclassified results cannot create an outage or confirm recovery. Known geographic failures stay down until that continent succeeds, or the operator changes/disables the geographic configuration. Old measurements are ignored when the URL, method, accepted codes or selected regions change.
- Failed locations and their last failure times persist through restarts. Alerts and recurring reminders name city, state (when present), country and continent. Recovery alerts include the previously affected locations. Incidents record their geographic cause.
- Maintenance and paused monitors suppress acquisition and evaluation of buffered geographic results.

## Globalping behavior

HTTP requests preserve scheme, hostname, port, path, query and GET/HEAD method, and use the monitor's accepted HTTP response codes. Ping results with packet loss count as failures, matching existing geographic check semantics. Target/network/DNS failures classified by Globalping as `target` or `resolver` count as down. `internal`, `offline` and unclassified failures are inconclusive. This classification is experimental and best effort in Globalping's API.

One probe is requested per selected continent, using per-location limits. Each probe has a 20-second timeout and the client allows another 10 seconds for API finalization. Body matching, local proxies and local TLS-ignore settings do not apply to public probes; Globalping controls its HTTP/TLS behavior. URLs with embedded username/password credentials are rejected instead of being published to the provider. Measurements and their targets are sent to Globalping, as with the existing feature.

Provider reference: [Globalping API](https://globalping.io/docs/api.globalping.io), [official API schema](https://api.globalping.io/v1/spec.yaml).

## Rollout

Build and deploy the application image normally. No new daemon, queue type, external service or database migration is required. The new MongoDB fields are optional. Geographic probing remains off for existing monitors where it was disabled. Existing geo-enabled monitors adopt this outage policy on deployment.

Set the optional server environment variable `GLOBALPING_TOKEN` to a dashboard access token to use the account quota. Pass it to the primary process and any separate workers, then restart them. Blank or unset tokens retain anonymous requests. The token is sent only in the authorization header when creating a measurement; it is not part of the probe request body or client configuration.

Choose regions/intervals within the account's current Globalping quota before enabling this across the estate. This change does not enable geographic checks on production monitors, add provider credentials or create notification channels. Notification channels must already be attached to each monitor to receive alerts.

Tests use provider fixtures and a disposable local MongoDB; they do not send real notifications or launch public probes.
