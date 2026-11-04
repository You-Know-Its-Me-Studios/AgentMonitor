# Claude Code observation capabilities

Installed and observed on Windows 11: **Claude Code 2.1.318**. `claude agents --help` exposes both `--json` and `--all`. The passive command `claude agents --json --all` successfully returned an existing interactive session with its native conversation UUID, exact live name, PID, start time, working directory and idle state. No session was attached, resumed, dispatched, relaunched, or configured.

## Discovery and identity

The adapter verifies `--json` in help before calling the noninteractive listing path. `--all` is used only when advertised. It validates that stdout is a JSON array. Process status (`busy`, `waiting`, `idle`) is separate from background task state (`working`, `blocked`, `done`, `failed`, `stopped`). A task can be complete while its process remains alive. Permission and sandbox prompts map to approval; explicit input prompts map to input waiting. Other dialog waits remain unknown.

Fallback discovery enumerates actual project directories beneath the discovered configuration root, without guessing path slugs. Default root is `%USERPROFILE%\.claude`; the orchestrator also supplies accessible configured roots and WSL namespaces. Main transcripts are `projects/<native-project-directory>/<session-uuid>.jsonl`. Associated `projects/<project>/<session>/subagents/agent-<id>.jsonl` files become child sessions; they do not become top-level tabs. Superseded and orphaned transcript copies are excluded.

For versions without JSON listing, `sessions/<pid>.json` is only a discovery hint. The fallback requires transcript identity, a matching Claude executable, and matching PID plus process creation identity. Transcript evidence must include activity after that process was created and the same reported working directory. A newer same-directory conversation contradicting the registry's claimed session/last update makes the binding unknown, covering stale entries after `/clear` or `/resume` conservatively. This can leave genuinely idle sessions unknown on old versions; supported JSON listing avoids that ambiguity. The observed Windows `procStart` field is a FILETIME string, compared with the OS process start time after conversion. Unrecognized process birth identity formats fail closed; recent file modification never proves liveness. Linux registry start-tick formats are not promoted to live state unless supported listing is available.

Native listing names take precedence. Transcript fallback priority is `custom-title.customTitle`, `ai-title.aiTitle`, summary, first genuine user prompt, then short native ID. Later prompts cannot overwrite explicit titles. Conversation identity is provider + root/runtime namespace + native ID. Native renames update the same identity.

A background job with only a short job ID and no native conversation UUID is counted in source diagnostics while its conversation is pending. Once JSON listing reports `sessionId`, its conversation appears automatically. A temporary job identity is not promoted to a conversation tab and cannot leave a duplicate historical tab behind.

## Installed transcript shapes

Inspected structural keys and numeric accounting only; no conversation or tool output was logged. Observed families include `user`, `assistant`, `system` with `turn_duration`, `cost-state`, `custom-title`/`ai-title`, `last-prompt`, `mode`, `permission-mode`, `tools-used`, `session-owner`, `api-request`, `api-request-shape`, `api-request-blob`, `queue-operation`, and attachments. Large request blobs, owner/account IDs, raw content blocks, tool outputs, and credentials are discarded. Unknown families are skipped with a coverage diagnostic.

One real transcript exceeded 200 MB. Byte-checkpoint backfill is progressive, while a bounded recent tail supplies current native metadata and recent records. Until backfill completes, usage explicitly covers only the observed prefix plus recent tail. Response IDs deduplicate overlapping tail and prefix records. No provider files are modified.

## Accounting and metrics

- Each assistant `message.id` contributes once. Multiple content blocks are retained as structural tool events, while repeated usage is replaced. Finalized revisions replace provisional snapshots; later provisional snapshots cannot replace finalized usage.
- Installed persisted responses report finalized `stop_reason` and output counts. Streaming placeholders without completion evidence have unavailable output. Input, cache read, and cache creation remain separate categories. Total includes uncached input + cache read + cache creation + output. Thinking tokens are an output subset and are not added again.
- Main transcript totals exclude sidechain records. Child transcript totals remain separate. Copied ancestor records whose native session ID differs from the current main transcript are excluded and establish fork lineage. Cumulative `cost-state` includes restored/subagent contributions and is never added to attributable response totals.
- `tool_use.id` and `tool_result.tool_use_id` correlate invocations and results. Explicit result success/failure is counted; missing outcome stays unknown and outside success denominators. Durations are observable wall times between invocation and result, not CPU time. Edit file names and structured patch line counts are retained only when attributable to an edit tool result.
- Reported `perTurnEffort`, model, cwd, branch, native turn durations and activity timestamps are exposed. The context input estimate is the latest API request's input plus cache categories; capacity stays unavailable without an explicit source. It is not a fabricated percentage gauge.
- ETA stays **Not enough data yet** until at least three same-plan checklist steps have observed in-progress→completed durations within a 4× spread. Remaining reported checklist steps then produce a broad low-confidence range from observed durations. Completion is the agent's reported checklist state, not independent verification. No token/tool-count or prose-based remaining-work inference is used.
- Subscription quota is unavailable. No supported subscription-quota integration was present. The adapter does not read authentication stores or scrape OAuth endpoints.
- API-equivalent cost is unavailable unless a source with known pricing and correctly scoped usage is added. Existing cumulative estimates are not represented as a subscription invoice or added across child sessions.

## Primary references

- [External JSON session discovery and state meanings](https://code.claude.com/docs/en/agent-view#list-sessions-as-json)
- [Native session naming, persistence and forks](https://code.claude.com/docs/en/sessions)
- [Configuration root and transcript/subagent storage](https://code.claude.com/docs/en/claude-directory)
- [Response-ID usage deduplication, finalized output, and cache semantics](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- [Status-line fields and rate-limit availability](https://code.claude.com/docs/en/statusline)

These documents describe current upstream capabilities. The implementation detects installed help flags and validates actual responses; it does not assume all upstream fields exist.
