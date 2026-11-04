# Current-session source investigation

This investigation used read-only native metadata and bounded reads of the existing histories. It did not resume or control working sessions, change agent settings, launch a browser, or launch the application. Diagnostics recorded schemas, timestamps, record counts, lengths, numeric accounting and native identities; conversation bodies, hidden reasoning and credentials were not printed.

## Installed sources and observed timestamp mismatch

The installed Codex version is 0.166.0. Its existing Windows daemon socket remains inaccessible to this restricted process (Windows socket error 10013), so current runtime liveness cannot be certified from file activity. Supported passive proxy observation remains implemented and capability detected. Native SQLite and persisted histories are available. Claude Code 2.1.318 supports the noninteractive `agents --json --all` listing; it remains the primary Claude runtime source.

The selected existing Codex parent conversation was traced through its native `threads` row, rollout, dashboard checkpoint, normalized activity projection and current tail. At the initial comparison:

| Source | UTC observation |
| --- | --- |
| First 4 MiB of rollout | Last complete record `2026-11-04T00:27:40.686Z` |
| Dashboard source checkpoint | Offset 6,806,025; last ingested activity around `00:55:20Z` |
| Native metadata `updated_at_ms` | Around `01:11:17Z` at one dashboard projection |
| Actual rollout records | Continued through `01:11:22.607Z`; file had grown to 7,308,552 bytes |
| Filesystem modification time | Still `00:27:04.602Z` while later records and byte growth were observable |

The old adapter could therefore show a fresh database recency timestamp beside an older tool/activity projection. A fixed timezone offset would not repair that ingestion mismatch. The database recency timestamp is no longer substituted for an ingested event's occurrence time. Discovery uses file identity and size as well as modification time; periodic enumeration remains authoritative.

Later, a source-only test read the first bounded prefix and an independent recent tail, merged their native identities, and asserted that the recovered task objective belonged to the latest **Update** request. That check passed with:

- Current task start `2026-11-04T01:08:49.029Z`.
- Task instructions recovered; active state; scope revision 1.
- Six instruction chunks of at most 3,500 characters, preserving the full latest request through the cache's per-string limit.
- Current model `gpt-6.1-sol`, reported effort `ultra`.
- Current native record time `2026-11-04T01:30:47.344Z`, while the initial prefix still ended at `00:27:40.686Z`.
- Bounded public request/correction/plan/progress/tool/result/subagent evidence, with private reasoning excluded.

Times advance while the real session continues. These are observed instants, not hardcoded application values. Canonical UTC normalization and browser IANA-zone formatting are separate. Original scalar timestamps remain beside normalized occurrence times; ingestion/check times are separate fields. Naive timestamps are rejected rather than assigned the backend's local offset.

## Native shapes that matter

Modern Codex records include `session_meta`, `turn_context`, `thread_settings_applied`, `token_usage_record`, typed `item_completed` items, raw response/tool records, public messages and inter-agent metadata. `thread_settings_applied.thread_settings` actually contains model, reasoning effort, service tier and cwd in this installation. Each response retains model/tier at its occurrence; later session settings are not retroactively applied to all historical consumption.

The canonical parent rollout's current session metadata timestamp differs from its native database creation timestamp after persisted history reconstruction. Conversation start uses the earliest canonical metadata for that native identity, while current-task start follows the latest substantive user request. Copied ancestor metadata never changes identity.

Subagent histories can copy ancestor records and rewrite their timestamps to the child's creation time. A timestamp-only exclusion is insufficient. Installed canonical metadata exposes `subagent_history_start_ordinal`; records below that boundary are excluded from the child's consumption, tool counts and current-task instructions. Native response IDs still deduplicate overlap and finalized revisions.

Approval reviewers report `thread_source: guardian_review` or `source.subagent.other: guardian`. Their database rows may omit the parent. Their canonical rollout metadata contains `parent_thread_id`, so a bounded header read supplies the exact native relationship and the separate approval-reviewer role. No ancestry is inferred from titles or working directories.

Raw orchestration calls and concrete typed results are deduplicated by native call identity. Known `exec` orchestration wrappers are excluded when concrete typed invocations cover that turn; unrelated raw tools are retained. Explicit in-progress/interrupted states remain distinct from invocations with no observed result. Missing durations stay unavailable. Reported native durations and observable invocation/result wall times are preserved.

Claude response records retain native response ID, model, service tier, and explicitly reported 5-minute/1-hour cache-write categories. Cache read/write remain separate from uncached input. No missing TTL or price category is invented. Child usage remains separate before inclusive aggregation.

## Current-task evidence

Only bounded public evidence is retained: genuine user instructions and corrections, explicit plans/checklists, public assistant updates, relevant tool summaries/results, subagent assignments/completions and native terminal events. Setup envelopes, request blobs, hidden reasoning, encrypted content, owner/account metadata and raw tool output are excluded. Recognizable secrets are redacted before evidence enters the normalized cache.

Stable evidence IDs survive replay and source rename. A correction changes scope revision; a status question or small progress update does not. New substantive implementation briefs reset task identity. Native completed-turn/final evidence permits reported completion, with coverage explicitly stating that task completion is not independently verified. A later correction reactivates the same task; a new implementation brief after a completed or paused task starts a new task.

Task boundary detection is conservative, deterministic phrasing-based inference rather than an independent semantic classifier. Ambiguous short follow-ups preserve identity. Large new implementation briefs are recognized even when a separately read tail no longer retains the previous terminal event. The observer receives the exact bounded public evidence and its coverage; uncertain or unrecovered instructions remain explicit, and cannot trigger a generic invented assessment.

At most 72 evidence items / approximately 56,000 characters are retained per current task. Current request chunks and constraints have priority over routine progress. Older low-priority evidence may be condensed, and coverage reports that condition. A recent tail cannot guarantee recovery of a request beyond its bounded window; progressive transactional backfill continues and missing instructions remain unavailable until recovered.

Provider reducer state changed and requires the dashboard's own `task-evidence-v2` reducer-cache migration. This migration does not touch provider databases or histories.

## Verification and remaining limits

Focused checks passed: 61 tests across current-provider observation, task evidence, Codex, Claude, ingestion and adapter/SQLite integration. Two observer-exclusion regressions were then added; the resulting provider/task subset passed 47 tests (Codex 13, Claude 21, current-provider 5, task-evidence 8). Whole-project TypeScript checking passed. The opt-in real parent prefix/tail/task source test passed separately, including expected current-request prefix, current timestamps and recovered instructions. It writes only an isolated temporary dashboard cache.

Real runtime liveness remains unavailable for Codex under the socket restriction. WSL access was denied in this environment; no stopped distribution was started. Full rendered-interface verification is outside this authorized source investigation. No live model assessment or working-session control was performed by this agent; the parent owns the explicitly authorized isolated observer-worker check.

## Follow-up runtime-state investigation

The passive installed `codex app-server daemon version` probe was repeated after feedback about an **Unknown** state. It again returned Windows socket error **10013**. The native `app-server-daemon/daemon.pid` contains PID, process-start FILETIME and executable identity hashes. Its recorded PID and creation FILETIME matched the existing Codex daemon's OS process creation identity. That proves the shared daemon process exists; it does not reveal whether a particular thread is running, waiting or idle. Native `thread-writer-locks/*.lock` files are empty and persist, so their presence is not promoted to thread liveness. No lock was acquired or changed.

Per-session state reasons now report the precise runtime limitation alongside the latest native started/completed/interrupted turn evidence. Current source collection remains current or backfilling independently of unavailable runtime status. No transcript timestamp, PID file, or writer-lock file is represented as verified **Running**. Metadata-only entries explicitly say source evidence has not yet been recovered.

When an existing observer transport is reachable, `activeFlags` maps documented approval/input waits separately, idle remains a loaded live state, `notLoaded` remains separate, and malformed/unknown wait flags produce an explained unknown state. Transport receive ordering prevents an older status broadcast from replacing a newer authoritative thread read. A disconnected observer no longer reuses cached verified runtime state. Claude listing reasons likewise distinguish an idle live process, an explicit wait, and a completed task whose process remains live.

Primary references are linked in [Codex sources](CODEX-SOURCES.md), [Claude sources](CLAUDE-SOURCES.md), and [timestamp rules](TIMESTAMPS.md). Actual installed schemas and responses take precedence over assumptions about newer upstream releases.
