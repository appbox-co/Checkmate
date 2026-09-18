# Geographic confirmation and recovery checks

A newly failing geographic region is retried immediately through Globalping. Only a second conclusive failure from that same continent enters the normal serialized status evaluator and can create an incident or notification. A successful retry cancels the provisional failure. Globalping may choose a different city or probe within the continent.

Both measurements remain in raw geographic history. The public location status shows an unconfirmed failure as awaiting a check; overall availability and outage history use confirmed incidents. Alerts continue to name the failed geographic location.

Confirmed failed regions and regions awaiting a conclusive retry are checked on a 60-second job interval. A successful recovery check clears that region immediately through the normal evaluator; a separate local outage can still keep the monitor down. Provider errors or missing probe results neither open an outage nor clear an existing one.

Healthy regions retain the configured geographic interval (15 minutes in production). The worker wakes each minute but only requests healthy-region probes when the next full sweep is due. Recovery attempts do not move that full-sweep timestamp. Probe execution, queue load and the existing scheduler retry/jitter can add delay; recovery is not guaranteed within exactly 60 seconds. Extra Globalping measurements are used only for confirmation, recovery or an overdue sweep with no usable provider result.

Full-sweep time and pending regions are stored with the existing monitor geographic state and survive worker restarts. Older observations are treated as full sweeps. Pausing, maintenance suppression, configuration validation and notification routing use their existing paths. No new environment variables or external services are required.

## Validation and rollout

Run the geographicOutages and schedulerReconcile MongoDB integration tests, plus checkPipeline, geoChecksService, globalPingService, statusService and statusPageLocations unit tests. The integration cases cover transient failures, confirmation, retry unavailability, persisted pending state, local checks arriving during a retry, failed-region recovery, healthy-region cadence and incident/notification counts.

Deploy the server build onto the current production image, retaining its frontend and unrelated source boundaries. Back up the database and compose environment first. Reconciliation updates existing geo job intervals; if a failed region still has an old 15-minute next-run time, bring only its active geo job forward to within a minute. Verify the running image, worker health, persisted geo job intervals, public API and unchanged monitor/channel configuration. Keep the previous image and environment for rollback; no destructive database migration is required.
