# Verification record

## Latest launcher and screenshot corrections

**187 tests in 22 files passed**, including the opt-in passive real Codex source check. TypeScript checking and the complete production build passed. The build writes `dist/build.json` and includes both the compiled backend and bundled frontend. No dashboard, browser, shortcut or real observer was launched during these corrections.

Nine isolated launcher tests cover matching-build reuse, simultaneous launches, safe stale-build replacement, paths with spaces, another workspace's port, wrong process command, reused PID and denied identity checks. Five lifecycle tests cover private restart authorization, instance binding, cross-origin rejection and build identity. The running production dashboard itself was left untouched; the next normal shortcut launch performs replacement if its old instance can be verified.

Screenshot regressions cover one newest-first activity timeline, source-aware runtime states, visible subagent timestamps, wrapping tabs, overflow access and keyboard navigation. Exact New York date/time regressions now check November 3, 2026 at **8:02 PM EST**, an event at **8:01:50 PM** with a ten-second age, summer EDT and the repeated fall hour.

The final real-source check exposed another source-selection gap: the task brief had fallen outside the newest 4 MiB of rollout while progressive backfill was still before it. A bounded read-only query of recognized native `thread_items` user-message rows now recovers the current request without scanning intervening tool output or replaying usage. The 14,841,953-byte real source recovered the original Update task at `2026-11-04T01:08:49.037Z` and current evidence through `02:15:26Z`. Synthetic tests verify thread isolation, canonical task identity and replay across a 5 MiB output gap.

The local `git add .` command was attempted and denied when creating `.git/index.lock` because repository metadata is read-only in this session. The connected GitHub API is used for the authorized source commit to `main`; local Git metadata is not changed by that route. Private caches, logs, generated build output and provider history are excluded.

The observer/runtime live-source limitations below still apply. A passing fixture worker response is not a successful authenticated model assessment.

## Current observer update

The latest implementation request explicitly authorized observer model calls, focused automated checks, type checking, the production build, and one bounded live assessment. It supersedes the prior no-model rule for assessment only. No browsers, screenshot reviews, dashboard launches, shortcut launches, provider configuration changes, or working-session control actions were performed for this update.

Implemented paths include task evidence recovery, both isolated CLI workers, structured response validation, persisted backend scheduling/settings/results/calibration, authenticated observer APIs, SSE delivery, Timing & Progress controls, per-model effort validation, response-scoped pricing, native/current branch separation, subagent aggregation, current-tail ingestion and shared timezone utilities.

Final checks passed: **161 tests in 19 files**, with the opt-in real native source test enabled; **TypeScript checking passed**; **the production build passed**. The real source check recovered the same current Update task after the latest correction (scope revision 2), with source events through `2026-11-04T01:49:36.676Z` while the first 4 MiB still ended at `00:27:40.686Z`. The selected session remained distinct from its subagents and observer runs. Test commands were `npm test` with `AGENT_MONITOR_LIVE_ROOT`, `AGENT_MONITOR_LIVE_THREAD` and `AGENT_MONITOR_EXPECT_TASK_PREFIX=Update`, `npm run typecheck`, and `npm run build`.

### Actual timestamp cause

This was a source-selection/backfill problem, not evidence of a fixed three-hour timezone error. The old normalized activity list lagged behind the growing rollout. Native SQLite update metadata could make Last Activity look newer than the activity events actually ingested. The rollout's modification time also stayed unchanged while its byte size and records advanced. Current-tail reconciliation now merges by native identity; database recency is not substituted for an event occurrence. Cache reducer version `task-evidence-v2` rebuilds dashboard-owned checkpoints only.

The passive real-source regression recovered this actual session's latest **Update** task, start `2026-11-04T01:08:49.029Z`, separate from conversation age; it recovered public instructions, recent tool/results/subagent evidence, model and effort. Original timestamp, UTC occurrence, ingestion and poll instants remain separate. Exact Eastern and summer/DST regressions are in `tests/time.test.ts` and [timestamp policy](TIMESTAMPS.md).

### Real observer attempts: not a success claim

The actual installed capabilities were verified: Codex 0.166.0 and Claude Code 2.1.318 support the required noninteractive isolation/output flags. Codex isolation also performs a source-verified **empty-stdin configuration preflight**, which exits before creating any turn or model request. This found and fixed a real bug where ignored user MCP definitions were recreated as incomplete overrides. Ordinary user MCP entries are excluded; full definitions present in the isolated execution view are disabled and revalidated without copying transports or credentials.

Bounded assessment attempts used the recovered current Codex task through the actual worker/service path. **No successful real-provider assessment was obtained in this restricted session.** Codex failed to initialize its in-process client with `Access is denied (os error 5)` after configuration validation. Claude was attempted as the alternate observer and reached the enforced **60-second timeout** without a structured result. Only application-created observer children were targeted for termination. No ETA or usage was fabricated, and the specific failures were persisted. The full success path is verified with isolated structured-response, process, HTTP, SQLite and SSE tests; that is not described as live provider success.

The existing Codex daemon socket also remains blocked here (10013). WSL live discovery remains unverified due access denial. Claude subscription quota has no supported ordinary local source. Missing cache-write TTL, unpublished model rates, and unreported duration/outcome fields remain explicit partial/unavailable states.

Public pricing is stored locally with an as-of date and source URLs in `src/server/pricing-registry.json`. API-equivalent estimates use [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing); they are not subscription invoices.

### Loading this build

The existing launcher and shortcut are preserved. Restart Agent Monitor normally to load the rebuilt backend and frontend; this implementation task did not launch or replace the running dashboard instance. Read [source investigation](SOURCE-INVESTIGATION.md) and [observer isolation](OBSERVER-SOURCES.md) for concrete limitations and recovery behavior.

## Earlier initial-build record

## Scope and final instruction

Implementation, tests, production build and local startup were initially authorized. The user subsequently instructed the agent to stop launching anything and keep the task to building. No further applications, browsers, shortcuts, or tests are to be launched under that instruction. Remaining work was limited to accurate project documentation.

## Executed checks

- Node.js 22.23.4, npm 10.9.9, Codex CLI 0.166.0, Claude Code 2.1.318 inspected.
- Whole-project TypeScript checking passed before the final Playwright configuration addition. The addition exposed an unsupported top-level `reducedMotion` option; it was corrected to `contextOptions.reducedMotion`. That final correction was inspected but not rerun after the user's stop instruction.
- The production build passed using Vite 7.3.7 and TypeScript 5.9.3. Frontend and backend artifacts exist under `dist`.
- Last combined test run: **63 passed, 8 test files**. Subsequently, the Codex suite passed with an additional malformed-record regression (12 Codex tests), and a new real-HTTP SSE reconnect test passed separately. A final combined rerun was not performed after the stop instruction.
- Claude/accounting/registry: 20 tests passed. Ingestion: 14 tests passed. Adapter/SQLite integration: 2 passed. Launcher: 3 passed. API boundary: 5 passed. Collector: 5 passed. Discovery: 3 passed. Codex: 12 passed. HTTP SSE: 1 passed. These are the latest focused results, not a claim of a final combined 65-test run.

## Live source evidence

The running dashboard API automatically discovered the current Codex conversation, native name **Build local session dashboard**, without resuming, restarting, attaching to, or sending input to it. Its persisted model/effort are GPT-6.1 Sol / Ultra. Normalized lifetime tokens matched the native reported snapshot in a read-only comparison. Modern and legacy counters were not added together.

The dashboard also observed an existing Claude interactive session using the installed supported `claude agents --json --all` path and reported its native **idle** state. Runtime state came from the native listing, not transcript modification times. At one observed reconciliation, the dashboard held 593 normalized sessions/history entries across both providers.

Codex's existing daemon socket returned Windows error **10013** in this sandbox. Persisted observation worked; live Codex runtime/task status remained explicitly unconfirmed. WSL enumeration returned access denied. No stopped distribution was started, and WSL live observation was not verified.

Real provider histories, credentials and configurations were not modified. Destructive lifecycle tests used isolated temporary source roots.

## Launcher and shortcut evidence

The actual production hidden launcher returned ready at `http://127.0.0.1:4317`. Isolated automated launcher tests exercised simultaneous launches, repeated launch, changed-port reuse, one collector, paths with spaces and `&`, missing builds, and wrong-workspace port collisions. Startup/server/error logs are under `.agent-monitor/logs`.

A real shortcut was created and its target, working directory, arguments and local icon inspected at:

`C:\Users\Josh\Desktop\You Know Its Me Studios\Agent Monitor\Agent Monitor.lnk`

Invoking that staged shortcut produced a second successful launcher readiness entry, reusing the existing application. The default-browser page could not be inspected.

Attempting to install `C:\Users\Josh\Desktop\Agent Monitor.lnk` failed with an unauthorized filesystem write. **No Desktop shortcut was installed.** The project contains the ready shortcut and `scripts/Install-DesktopShortcut.ps1` for normal current-user installation outside this restricted session. No administrative privilege is required by the installer.

No reboot was performed. Reboot compatibility is established by the persistent shortcut target and production launcher design, rather than a reboot test.

## Browser/UI limit

Six Playwright navigation/security/responsiveness tests and a standalone real-session CDP runner are implemented. **They did not pass or complete in this environment.**

The browser connector had no connected debugging browser. Isolated cached Chromium attempts failed with Windows IPC/Mojo access errors and produced an application-error dialog. Those were verification processes, not dashboard code. Native computer-use and browser-host tools were unavailable. Further launches were stopped at the user's instruction.

Therefore the interface is implemented from the supplied visual reference and wired to real API/SSE data, but **actual rendered layout, interactive browser journeys and responsive screenshots remain unverified**. Fixture tests are not described as live UI verification.

For a normal, explicitly authorized future verification session, `npm run test:browser` selects only `tests/browser` and uses the production localhost server. The standalone runner `node tests/browser/run.mjs` requires an already-running isolated CDP browser at `AGENT_MONITOR_CDP` (default port 9333). Neither command should be run under the user's current stop instruction.

## Build environment detail

Network access was disabled. Dependencies were installed from the machine's npm cache into this workspace. This Windows restricted token also denies child-process stdio pipes. Builds use TypeScript's in-process transpiler and native Vite config loading, with no esbuild service requirement; the backend compiles with `tsc`. CLI observation falls back to short-lived private file handles when anonymous pipes are denied, deletes captured output immediately, and never forwards raw command output to the browser.

No Git repository existed in this directory. No commit, push, deployment, provider update, service, scheduled task, firewall change, or system reboot was performed.
