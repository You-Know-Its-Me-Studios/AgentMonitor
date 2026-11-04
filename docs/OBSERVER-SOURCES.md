# ETA delegation through the installed CLI

The configured ETA provider/model/effort launches a separate, bounded CLI coordinator. The coordinator must ask exactly one new CLI subagent **“How much remaining time”** and wait for its response. The backend supplies the selected session's bounded, redacted task evidence directly in that child's temporary role instructions. The coordinator does not regenerate the evidence as tool-call output or estimate the time itself. The backend accepts the completed child response, validates its existing assessment schema and evidence references, and stores that response without changing its ETA values. Parent-only answers are rejected. Existing cached assessments from the previous method remain accessible as previous estimates, not current subagent replies.

The existing scheduler still controls selection, interval, coalescing, concurrency, timeouts, backoff and superseded-task rejection. The dashboard does not send this question into the monitored working conversation, resume it, or take ownership of it. Evidence is assembled explicitly; a subagent is not assumed to inherit the monitored conversation.

## Installed capabilities inspected

Native help and version output were inspected for Codex **0.166.0** and Claude Code **2.1.318**. Codex’s matching versioned configuration schema and exec-event source establish the supported agent settings and completed-child message format. Claude’s official subagent and SDK documentation establish CLI agent definitions, Agent calls, `parent_tool_use_id` correlation and tool-result responses.

This change was checked with the production build only. No new live model assessment, test suite, browser automation or manual UI verification was run for it.

## Codex

A new `codex exec --ephemeral --ignore-user-config --ignore-rules --strict-config --sandbox read-only --json` coordinator enables `multi_agent` and configures one concurrent child with maximum depth one. The application writes an `eta_assessor` role configuration and separate coordinator/assessor instructions into its owned temporary directory. The child uses the selected model/effort and has further delegation disabled. Shell, hooks, plugins, apps, browser/computer, images and unrelated action features remain disabled. MCP candidates are validated against the isolated configuration and disabled as before; no credential transport definitions are copied.

The running build `9540714cb8f6` timed out at `2026-11-04T15:36:49.411Z` and again at `15:40:19.923Z`. Source inspection identified two additional defects: it instructed the coordinator to regenerate the complete evidence packet (the selected task held over 26,000 evidence characters), and the installed role loader ignores `model_instructions_file`/`[agents]` overrides. The child therefore inherited the coordinator-only base instructions. The shared base is now role-neutral; supported `developer_instructions` supplies each distinct role, with evidence supplied directly to the child. V1's parent-configured depth-one limit blocks recursive delegation. Timeouts retain bounded output in memory long enough to report native session/child/completion counts and redacted diagnostic lines; raw evidence and answers are not logged. The lost output prevents attributing the earlier timeout to one particular phase, and the repaired path has not been live-provider verified.

Codex 0.166.0 resolves model-specific tool/delegation modes ahead of disabled feature flags. The local `gpt-6.1-sol` and `gpt-6-astra` definitions select `code_mode_only` and V2; disabling Code Mode's host while retaining those definitions made the coordinator unable to use the intended delegation path. The failed run at `2026-11-04T15:26:36.102Z` returned no accepted completed child reply. The worker now uses the supported per-process `model_catalog_json` setting with a copy of the selected native model definition, explicitly selecting `direct` tools and `v1` delegation and disabling deferred tool search. Other model metadata is preserved. This matches the native V1 JSONL completed-child contract without enabling shell/Code Mode execution. The isolated catalog participates in the existing no-input configuration preflight and is deleted with the run directory; user catalogs are never edited. This repair was production-built, not live-provider verified. Missing replies now retain native error diagnostics and bounded event-type/child counts, without logging transcript contents or substituting the coordinator's answer.

The parser requires a native successful `spawn_agent` event containing the remaining-time question, followed by a completed response from that same child identity. Only waiting/closing that newly created child is accepted. A coordinator’s final message/output file cannot supply the estimate. Unexpected work/tool actions, missing delegation, failed children or invalid child JSON fail the assessment and leave the previous result intact.

Exec’s reported usage is retained separately from monitored-session usage. Its parent turn counter must not be represented as a verified inclusive child token total; the native completed-child message does not supply that breakdown.

## Claude

The new print-mode run uses `--restricted`, empty ordinary setting sources, hooks disabled, no plugins selected, no Chrome, strict empty MCP configuration and no session persistence. It keeps ordinary CLI-owned authentication; it does not use `--bare`. Safe mode is omitted because it disables custom agents. The only enabled built-in capability is `Agent`, restricted by the application-owned coordinator definition to `eta-assessor`. The child has an explicitly empty tool set and no MCP servers, hooks, skills or recursive agent tools. Per-process depth/concurrency limits are one. Both definitions use the selected model/effort; no permanent user settings are changed.

`--output-format stream-json --verbose` exposes the native Agent invocation and correlated response. The parser requires one `Agent`/legacy `Task` call for the named ETA child and a successful matching tool result. It obtains assessment JSON from that child’s `parent_tool_use_id` messages or matching native result text, never from the coordinator’s structured final answer. Reported result usage stays separate from monitored usage.

## Ownership and privacy

Workers run beneath the application-owned temporary `.agent-monitor/observer/<workspace-hash>/work` namespace. Discovery excludes that namespace, including child sessions. The short coordinator request travels through stdin; bounded/redacted evidence is written to the app-owned temporary child role file, never interpolated into shell commands or arguments. Provider authentication remains inside the CLI. Only processes created and tracked by the existing runner can be terminated on timeout/abort. Temporary instructions, role definitions, schema and captured output are removed after completion/failure. Native managed policy remains effective.

Stored delegation provenance contains the question and native request/child identity. Session/task identity, assessment time and request revisions continue to be assigned by the backend. No child may invent measured token counters, runtime status, context capacity or account allowance.

## Primary references

- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex noninteractive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Installed-version Codex configuration schema](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/config.schema.json)
- [Installed-version Codex exec event definitions](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/exec/src/exec_events.rs)
- [Installed-version model/delegation precedence](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/config/mod.rs)
- [Installed-version supported child-role overrides](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/agent/role.rs)
- [Installed-version native tool modes](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/protocol/src/openai_models.rs)
- [Claude subagent configuration](https://code.claude.com/docs/en/sub-agents)
- [Claude native delegation messages](https://code.claude.com/docs/en/agent-sdk/subagents)
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
