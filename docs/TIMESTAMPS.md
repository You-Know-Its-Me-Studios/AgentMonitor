# Timestamp policy

Native occurrences are normalized once by `normalizeTimestamp` into a UTC ISO instant. Supported input is a numeric Unix timestamp in seconds or milliseconds, or an ISO date/time with an explicit `Z` or numeric offset. Ambiguous date/time strings are rejected. An adapter may opt into `naive: 'utc'` only when its installed source contract explicitly defines a timezone-free field as UTC.

Adapters retain the original timestamp where available. Event occurrence (`occurredAt` / legacy `at`), ingestion (`ingestedAt`), and collector checks (`lastCheckedAt`) are separate evidence. A successful SSE update or recent ingestion does not make an old event current. Relative ages and sorting compare instants, independently of display timezone.

The browser displays the operating system/browser IANA timezone by default; the Timing & progress settings allow an explicit IANA timezone override. `Intl.DateTimeFormat` applies the offset and daylight saving rules once at presentation. Date/time tooltips include the date and timezone abbreviation. Allowance resets, history, chart times, task assessments, and recent activity use this same path.

Regression examples: `2026-11-04T01:02:00Z` is November 3, 2026 at **8:02 PM EST** in `America/New_York`. An occurrence ten seconds earlier displays **8:01:50 PM EST** with age `10s ago`. Summer uses EDT; the two repeated `1:30 AM` fall occurrences retain their one-hour chronological order. Backend `TZ` changes must not alter these instants or explicit-zone displays.
