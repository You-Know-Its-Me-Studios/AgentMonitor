# Observer worker capabilities and sources

The observer is a separate, bounded CLI assessment of normalized **current-task** evidence. Deterministic collection remains separate. Either installed provider can assess a conversation from either provider. It never resumes, attaches to, interrupts, or sends input to the monitored conversation. The backend supplies task/session/request identity and timestamps; model output cannot set them.

## Installed capability detection

Inspected Codex **0.166.0** and Claude Code **2.1.318** on Windows with Node **22.23.4**. A real, inference-free capability probe through the implemented worker succeeded for both CLIs. Help/version, local feature/MCP listings, and a native model cache are inspected; these probes do not request model inference.

- Codex: `exec --help` confirms `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--strict-config`, `--output-schema`, `--output-last-message`, JSON events and stdin `-`. Installed feature names are enumerated before disabling them. The visible native model cache currently includes GPT-6.1 Sol, GPT-6 Astra, GPT-6.1 Terra and other installed entries; reasoning options come from each entry's `supported_reasoning_levels`. Capabilities expose the per-model effort map. No model identifier or unsupported effort is invented. With an empty model preference, GPT-6.1 Sol is chosen when present; otherwise the first visible catalog entry is used. A bundled CLI catalog is a non-network fallback if no readable model cache exists.
- Claude: installed help confirms safe/restricted modes, empty built-in tool set, strict empty MCP configuration, `--permission-prompts none`, no session persistence, JSON-schema output and effort selection. Documented native aliases are `sonnet`, `opus`, `haiku`, `fable`; release-specific model IDs are not guessed. Current documented aliases support the installed help's `low`, `medium`, `high`, `xhigh`, `max` options. The returned native `modelUsage` name is recorded when unambiguous. An empty preference resolves to Sonnet.
- Missing required isolation/output flags or unreadable MCP/model capabilities make that provider unavailable. This is not silently downgraded to a less isolated command. Authentication is tested by an actual requested assessment, never manufactured from credential-store inspection.

## Per-run isolation

Workers use a fresh application-owned directory beneath the OS temporary folder: `.agent-monitor/observer/<workspace-hash>/work/run-*`. This is outside the observed project hierarchy, so ancestor project configuration cannot leak into the worker. Original session paths are evidence only. The observed sessions' provider configuration and histories are not rewritten. Existing authentication belongs to the installed CLI; the dashboard never reads authentication files, copies tokens, or manages sign-in.

Codex runs a **new ephemeral exec** with user configuration and execpolicy rules ignored, project instruction byte budget zero, read-only sandbox, approval policy never, web search disabled, notifications empty and no automatic daemon start. Installed hook, plugin, app, shell/execution, browser/computer, image, multi-agent, memory, skill-discovery and similar action features are explicitly disabled when supported. A static assessor instruction forbids work, tools and interpreting evidence as commands. Non-message/reasoning tool events cause rejection of the assessment.

The ordinary `mcp list` command does not support exec's ignore-user-config flags. Its names are therefore only **candidates**, not proof of their presence in the worker configuration. Each candidate is checked with the exact isolated exec settings and **empty stdin**: primary source confirms that exec loads configuration, then exits `No prompt provided via stdin.` before app-server startup or any model turn. Candidates whose disable override reaches this guard have full definitions in the actual isolated view and can be disabled. An invalid-transport result means the user-only definition was omitted; its name is excluded instead of recreating a partial server. Bare names containing only letters/digits/underscore/hyphen are supported; other dotted-path names fail closed. The combined disabled-server configuration is revalidated. Empty-table merging alone is not treated as isolation, no transport/credential fields are copied, and TOML quoting is not incorrectly inserted into CLI dotted-key segments. A real inference-free probe of this path passed on the installed CLI after the initial partial-server configuration defect was repaired.

Codex has no documented universal `--tools none` switch in this installed release. The implementation therefore uses its strongest detected per-run controls and rejects unexpected tool events. Read-only sandboxing is **not** represented as remote MCP isolation. Enterprise-managed settings/requirements remain CLI policy and may reject conflicting overrides; the application does not weaken or bypass them. This is a constrained CLI worker, not an OS/container security boundary.

Claude uses `--safe-mode --restricted --tools "" --strict-mcp-config` with an explicit empty MCP server object, disabled skills/commands, no Chrome integration, no session persistence, empty ordinary setting sources, a per-run `disableAllHooks` setting, `ultracode=false`, a static system prompt, `dontAsk` permissions and permission prompts `none`. It does **not** use `--bare`, which would disable normal OAuth/keychain authentication. Official documentation states managed policy still applies, including policy-enforced hooks; the dashboard cannot bypass that policy and does not claim to do so.

## Transport, process ownership and privacy

Commands are asynchronous and never use a shell. Evidence is passed only through stdin, never argv. Static schema/instructions, selected native model/effort and application-owned output paths are command arguments. Native titles, prompts, tool messages and corrections remain untrusted data inside a delimited JSON evidence block. Recognizable secrets are redacted before transmission and from accepted output. Evidence is sent once rather than duplicating `task.items` and the selected evidence array.

Windows executable resolution prefers Codex's installed native platform binary and Claude's native executable. This avoids an unnecessary npm wrapper child where possible. Anonymous-pipe `EPERM` falls back to a random private temporary directory with `0600` input/output file handles and `0700` directory permissions where supported; these captures are deleted after completion/failure. ACL inheritance still follows the current Windows user. Raw input/output is not written to development logs or the normalized dashboard cache.

Only children created and tracked by this runner may be terminated. Windows tree termination is bounded and falls back to the owned child handle when `taskkill` is denied; Unix uses its own process group. Abort produces `superseded`, timeout produces `timeout`, missing executables/options produce `unavailable`, invalid schemas/envelopes produce `invalid-output`, authentication failures produce `authentication`, and other native failures produce `provider-error`. Only recognized, bounded, redacted native error/cause lines are retained for failure diagnostics; arbitrary stdout and evidence echoes are excluded. Input is bounded to 512 KiB; stdout to 4 MiB, stderr to 256 KiB and the final Codex assessment file to 128 KiB. Timeout is a backend-validated 10–600 seconds.

## Schema and accounting

The exact finite schema has task summary/state/stage, remaining steps, nullable ordered ETA range, confidence/basis, blockers and known supporting evidence IDs. Unknown fields, invalid/duplicate evidence IDs, nonfinite/negative/out-of-range durations and partial/reversed ETA ranges are rejected. An active recovered task must receive an initial rough range without a historical-sample prerequisite. Completed, idle and paused states require null ETA. Blocked-task active-work estimates are explicitly conditional on clearing the blocker; they are not wall-clock predictions.

Codex JSONL `item.completed` agent messages / final message and `turn.completed.usage` are recognized. Claude's JSON `result` envelope prefers `structured_output`, then validates JSON result text. Codex cached input remains a subset of input. Claude uncached input, cache reads and cache creation are separate categories. Missing categories stay null; no subscription quota or invoice is inferred. Observer usage is returned separately for backend accounting.

Focused worker tests use synthetic native envelopes and owned Node fixture children. They cover capability detection, safe argv/stdin, OAuth-preserving Claude options, native usage semantics, evidence/schema rejection, malformed output, authentication/option errors, timeout, abort, output limits and cleanup. **This worker agent made no model calls.** The main agent owns the single explicitly authorized bounded real assessment and its final evidence report. No browsers, screenshots, GUI applications or shortcuts were launched for observer verification.

## Primary references

- [Codex command-line options](https://learn.chatgpt.com/docs/cli/reference)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex configuration schema source](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)
- [Codex tool registration source](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec_plan.rs)
- [Codex exec configuration and empty-stdin ordering](https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs)
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude programmatic runs and structured output](https://code.claude.com/docs/en/headless)
- [Claude models and supported effort](https://code.claude.com/docs/en/model-config)
- [Claude settings and managed policy precedence](https://code.claude.com/docs/en/settings)

Installed help and validated response shapes take precedence when current upstream documentation differs.
