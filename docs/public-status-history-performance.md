# Public status history performance

The 30, 60 and 90 day views share persisted summaries of completed calendar days. Today is queried on every request. Confirmed incident intervals are queried separately, so incident edits and recovery boundaries affect public availability immediately.

Each request validates completed-day summaries against the retained check count and latest immutable insertion timestamp for each selected monitor. Normal check deletion, retention expiry and historical insertion invalidate the summary. New observations receive a historyInsertedAt stamp independently of their supplied check date. Older observations remain unchanged. Raw check values are immutable time-series observations; product code only inserts and deletes them. A summary is published only when validation is unchanged across its calculation.

Summaries live in the disposable `statuspagehistorysummaries` collection, with a two-day TTL. Keys include team, selected monitors, timezone, date bounds and calculation version. Missing or invalid summaries are rebuilt synchronously; this initial rebuild can take longer than a normal request. At midnight, previously completed days are validated and carried forward; only the newly completed day is calculated. There is no stale-response fallback. Removing this collection only affects performance.

Administrative imports that reuse both old insert timestamps and old observation counts must clear the summary collection. The product does not perform such imports.

Daily aggregates preserve MongoDB's timezone, daylight-saving and rounding behavior. Confirmed monitor downtime and raw geographic failures remain distinct. Day-range responses include one latest sample per location for its current status; the latest view retains fifty samples per location. The frontend uses daily buckets for day-range charts.

The newest geographic location samples used in day-range views share a separately keyed summary in the same disposable collection. Each request validates retained geographic counts, newest observation dates and immutable insertion stamps. New checks, deletions, future observations becoming current and configuration changes refresh these rows. Each range still applies its original observation lookback. The latest view continues to read fifty samples directly. Simultaneous requests with the same changed revision share one location refresh.

Overlapping requests for the same day-range page and monitor selection share the calculation already in progress. Page configuration, range and requester team remain separate. The promise is removed on success or failure; completed responses are not cached by the service, and the next request reads current data.
