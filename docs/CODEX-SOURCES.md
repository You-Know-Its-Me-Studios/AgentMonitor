# Codex source capabilities

Tested installed CLI: **codex-cli 0.166.0**, Node **22.23.4**, Windows 11. Its generated experimental JSON schema was inspected locally. The installed help confirms `app-server daemon version` is a passive JSON version probe and `app-server proxy [--sock PATH]` bridges an existing control socket. The dashboard never starts a daemon or app-server, resumes a thread, subscribes through resume, submits input, or changes configuration.

On this execution environment the existing daemon socket returns Windows socket error **10013** (sandbox access restriction). Therefore live runtime/loaded/approval states could not be verified through the daemon here. Persisted discovery **did** locate the already running parent conversation by native ID, model `gpt-6.1-sol`, effort `ultra`, native name, and its current rollout. Its history mode is `paginated`; modern usage and typed completed items are present in the rollout. A direct read-only normalization matched the latest reported thread usage exactly. Runtime status is explicitly unavailable when this socket cannot be reached. A recently active transcript is marked **unknown runtime**, with its inference explained; older file-only sources are labeled historical. Recent mtime is never treated as liveness.

## Discovery and observation

- Source roots are supplied by orchestration: discoverable `CODEX_HOME` and native default `%USERPROFILE%\.codex`, plus accessible running WSL namespaces. Identity includes the root namespace and native UUID, never the title or directory.
- Recursively enumerate `sessions` and `archived_sessions` including dated/flat layouts. Native SQLite rollout paths supplement discovery.
- Read the append-only `session_index.jsonl` transactionally using the shared byte reader. The latest applicable record (`id`, `thread_name`, `updated_at`) wins; native live name wins when observable. Rename does not change identity.
- Enumerate `.sqlite`, `.sqlite3`, and `.db` candidates in the root and discoverable `sqlite_home`/`CODEX_SQLITE_HOME`; inspect table columns before selecting recognized fields. No schema version filename is pinned. Open **read-only**, `query_only`, short SELECT, 100 ms busy timeout. Never migrate, repair, vacuum, or checkpoint provider databases. Recognized `threads` and `thread_spawn_edges` supply names, paths, branch, configured model/effort, archive state, ancestry and timestamps. No account credentials or authentication stores are read.
- If the passive probe succeeds, proxy through the existing server, initialize/initialized handshake, read `thread/loaded/list` before and after enumeration, use `thread/list` with `useStateDbOnly:true` (never repair-scan fallback), `thread/read` without turns, and `account/rateLimits/read`. Read-only RPC allowlist prevents agent control. Lifecycle/name/usage notifications enrich periodic reconciliation; no assumption that per-thread item/token streams are broadcast to an observer.
- Historical backfill is bounded: 12 most recently modified sources plus 20 rotating older sources per reconciliation batch, four simultaneous ingestion reads. SQLite metadata makes existing history available immediately while detailed metrics backfill.

## Record shapes and accounting

- `session_meta.payload.id` establishes the canonical conversation. Filename/database ID is the expected native identity; copied ancestor metadata cannot replace it. `turn_context` updates cwd/model/effort. Source subagent parent and fork IDs remain separate.
- Modern `token_usage_record`: native `response_id` plus `turn_id`; `usage`, `turn_token_usage`, `thread_token_usage`. Final duplicate revisions replace earlier contributions. Prefer reported thread cumulative usage for a normal conversation. For fork/subagent histories, use own-thread deduplicated responses and exclude ancestor thread IDs. Legacy fork/subagent totals require an observable inherited cumulative baseline; ambiguous inherited totals remain unavailable.
- Legacy `event_msg` / `token_count`: `info.total_token_usage` is a cumulative snapshot, **never summed** across records. `last_token_usage` describes the latest response. Modern and legacy lifetime totals are never added.
- Cached input is a subset of input, reasoning output a subset of output. Preserve reported total independently. Missing categories stay null. Current-turn consumption is separate from lifetime consumption.
- Context capacity is reported `model_context_window`. Occupancy is labeled **derived latest response footprint** (`last_token_usage.total_tokens`), since pending input can change actual context. Footprints older than five minutes become stale using their actual usage timestamp; explicit compaction invalidates the footprint until another usage record arrives. No guessed model capacity.
- Native `event_msg.item_completed` typed items recognize command executions, file changes, MCP calls, search, image view, subagent calls and dynamic tools. Native item ID deduplicates repeated item/output presentations. Typed invocations are authoritative in paginated turns; raw calls are legacy fallback. Unknown outcomes stay out of the success denominator. Durations are reported execution duration or explicit start/end difference. Retry counts remain unavailable when not reported.
- `task_started` / completion records supply observed completed-turn duration. Session elapsed span is distinguished from active compute time. Explicit `update_plan` checklist state may be shown as reported progress; ETA remains “Not enough data yet” without a comparable-duration basis.
- File additions/deletions derive from attributable typed file-change diffs. These are observed operations, not the shared workspace Git diff. Prompts, reasoning, command strings and tool outputs are not cached/displayed.
- Account allowance buckets preserve limit ID, primary/secondary identity, duration, reset timestamp and observation time. They are shared account snapshots, never summed per session. Snapshots older than five minutes or past reset are **stale**, never automatically refilled. Distinct configuration namespaces are kept separate rather than asserting account equivalence.
- API-equivalent pricing remains unavailable unless exact model pricing and required categories are known. No subscription invoice is inferred.

## Limits

Socket access determines real runtime status coverage. File-only sessions are historical/unknown runtime, even if active in another terminal. Unrecognized record families are skipped with coverage diagnostics. Temporary locks retry. Root settings hidden only in another process's private environment cannot be guaranteed. Metadata SELECTs are bounded at 20,000 threads; large histories backfill progressively. Independent Windows/WSL namespaces are not merged by path or PID.

## Primary references

- [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Environment and configuration locations](https://learn.chatgpt.com/docs/config-file/environment-variables)
- [Codex CLI dispatch](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs)
- [Daemon implementation](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/src/lib.rs)
- [Protocol and usage definitions](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)
- [Native naming index](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/session_index.rs)

Upstream source may differ from the installed release; installed schema and structural source records govern supported parsing. Tests use synthetic records and isolated fake roots, never modify native history.
