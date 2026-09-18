# Public availability history

Public status pages use the confirmed incident state at each recorded observation.
A failed individual check outside an incident does not lower public uptime.
Successful probes inside an incident remain down publicly until the incident is resolved.
Incident start times are inclusive and recovery times are exclusive.

The recent view shows this state at each recent check's timestamp. Its percentage
covers retained check history. The 30/60/90-day views calculate their percentages
from observations in the selected local calendar dates. These are observation
percentages, not a wall-clock SLA calculation. Missing days remain blank, and a
monitor without observations has no percentage.

Raw checks, private diagnostic statistics, incident creation and notification
thresholds are unchanged. Failed probes remain available for diagnosis.
Failed probes do not produce artificial zero-millisecond response times on the
public page.

Availability queries are scoped to the page's team and selected monitors.
Incident lookup failures fail the request instead of producing an all-up result.

Run the focused regression tests from server:

```sh
npm test -- --runInBand --no-coverage test/unit/services/statusPageService.test.ts test/unit/services/statusPageConfirmedHistory.test.ts test/integration/statusPageConfirmedHistory.test.ts
```
