# Public status history performance

The 30, 60 and 90 day views share persisted summaries of completed calendar days. Today is queried on every request. Confirmed incident intervals are queried separately, so incident edits and recovery boundaries affect public availability immediately.

Each request validates completed-day summaries against the retained check count and latest immutable insertion timestamp for each selected monitor. Normal check deletion, retention expiry and historical insertion invalidate the summary. New observations receive a historyInsertedAt stamp independently of their supplied check date. Older observations remain unchanged. Raw check values are immutable time-series observations; product code only inserts and deletes them. A summary is published only when validation is unchanged across its calculation.

Summaries live in the disposable `statuspagehistorysummaries` collection, with a two-day TTL. Keys include team, selected monitors, timezone, date bounds and calculation version. Missing or invalid summaries are rebuilt synchronously; this initial rebuild can take longer than a normal request. There is no stale-response fallback. Removing this collection only affects performance.

Administrative imports that reuse both old insert timestamps and old observation counts must clear the summary collection. The product does not perform such imports.

Daily aggregates preserve MongoDB's timezone, daylight-saving and rounding behavior. Confirmed monitor downtime and raw geographic failures remain distinct. Day-range responses include one latest sample per location for its current status; the latest view retains fifty samples per location. The frontend uses daily buckets for day-range charts.
