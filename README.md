# Agent Monitor

A local, passive dashboard for existing Codex CLI and Claude Code sessions. Start the dashboard once and continue launching your agents normally. It does not resume, attach, submit input, change agent settings, or launch a provider daemon.

## Start on Windows

The production launcher is:

```powershell
.\Start-AgentMonitor.cmd
```

Dashboard: **http://127.0.0.1:4317**

A ready-to-copy **Agent Monitor.lnk** is included in this folder. The shortcut starts the production Node server hidden, waits for readiness, and opens your default browser. It compares the running server with `dist/build.json`: repeated launches reuse the same build, while a newly rebuilt version replaces the verified stale dashboard before opening. Codex and Claude processes are untouched. It works without a development terminal and after reboot; it does not auto-start on login. Its target is the local hidden launcher, and its icon is bundled in `scripts/agent-monitor.ico`.

The Desktop installation was blocked by this session's filesystem sandbox. **No Desktop shortcut was installed.** The installer targets the current user's resolved Desktop (`%USERPROFILE%\Desktop\Agent Monitor.lnk` unless Windows redirects it).

To recreate the shortcut after moving this folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-DesktopShortcut.ps1
```

Keep this application folder and its `node_modules` and `dist` folders. Node.js 22.13 or a newer supported even-numbered LTS release must be installed. Startup errors show the log location under `.agent-monitor\logs`. There are no administrator, service, firewall, Docker, API key, or cloud requirements.

## Build and development

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm start
```

`npm run dev` builds and watches the compiled backend. Run `npm run build` after source edits to refresh it. The production build fingerprints backend and frontend together. Open the shortcut after rebuilding to load that exact build. `npm run dev:ui` watches frontend assets only; run the complete production build before using the shortcut. The production frontend and API share one loopback origin.

Browser verification commands and results are recorded in [verification](docs/VERIFICATION.md). Parser, accounting, file-lifecycle, discovery, API security, launcher, and browser tests use isolated synthetic provider roots. No test mutates your provider history.

## What appears

- Existing and newly created native sessions, with stable identities and native names. Renames update the existing tab and selected browser title. New sessions do not steal selection. Refresh preserves selection.
- Model, reported effort, project, branch, cwd, timings, activity, reported tokens, cached input, reasoning where available, tool outcomes, attributable edits, and child-agent usage.
- Separate context occupancy, current-turn consumption, lifetime consumption, and shared account allowance windows. Unknown metrics remain unavailable. Expired allowance snapshots remain stale until a fresh observation arrives.
- Searchable local history, archived sessions, source diagnostics, and provenance tooltips. Subagents are nested beneath their parent.
- Source-aware runtime labels and visible subagent activity timestamps. A recent transcript is labeled activity evidence rather than verified Running. Recent activity is one newest-first timeline. Session tabs wrap within their space, with explicit access to additional sessions instead of an empty inner scrollbar.
- A separate AI observer assesses the selected current task: objective, stage, remaining work, a time range, confidence, basis, blockers and evidence references. An initial rough estimate does not require historical samples. Conversation age is kept separate from current-task elapsed time.

## Task observer and Timing & Progress

The **Timing & Progress** panel contains automatic assessment, interval, **Refresh now**, provider/model/effort, timeout and timezone controls. Automatic assessment defaults to one minute and applies to the selected active top-level conversation. Settings and previous assessments persist in the local cache. Historical, completed and explicitly paused tasks do not receive recurring assessments.

Both installed Codex and Claude CLIs can assess either provider's conversation. The backend supplies a bounded packet of public task instructions, corrections, plans, recent progress, tool/build/test results, subagent evidence and source freshness. It does not assume the observer inherits the working agent's context. Task identity and scope revisions reject late obsolete results. Native runtime state and AI-inferred task state remain separate.

The backend owns one scheduler for all browser windows, coalesces refresh requests, permits one worker per session with a small global limit, enforces timeouts, skips catch-up bursts after sleep and backs off on errors. Previous results stay visible during refresh or failure. An exceeded estimate is labeled rather than silently counting down to zero. Blocked estimates describe active work after the dependency clears.

Workers use a new noninteractive execution, a neutral application-owned directory, stdin evidence, per-run customization/tool restrictions, ephemeral/no-persistence settings, and CLI-owned authentication. They never resume or send input to the monitored conversation. Observer consumption is separate from monitored usage, while native account allowances still reflect actual shared account consumption. No login tokens are extracted. Managed administrative policy remains enforced by the CLI.

Dates default to the browser's IANA timezone; the optional override accepts names such as `America/New_York`. Activity tooltips distinguish original occurrence, ingestion and source checks. Reading old records or receiving a heartbeat cannot make native activity fresh. Source freshness is shown separately from browser stream connectivity.

Codex prefers a read-only observer connection to its **existing** shared daemon. Where that socket is unavailable, native read-only metadata and rollouts still show sessions and metrics, with unconfirmed runtime status clearly labeled. Claude prefers the supported `claude agents --json` listing and supplements it with transcripts. File modification alone is never presented as proof that an agent is running.

## Source roots and WSL

Default roots are `%USERPROFILE%\.codex` and `%USERPROFILE%\.claude`; discoverable `CODEX_HOME` and `CLAUDE_CONFIG_DIR` roots are included as well. Codex's configured SQLite location is capability-detected. Default paths are never replaced by an additional configured root.

On Windows, only distributions reported by `wsl --list --running --quiet` are inspected. Read-only bounded Python 3 helpers run in their Linux user namespace. Stopped distributions are skipped. WSL access failures are visible in Diagnostics; native Windows observation continues.

For an accessible custom root that cannot be discovered from this process's environment, optionally create `agent-monitor.config.json` in this folder:

```json
{
  "port": 4317,
  "pollMs": 2000,
  "wsl": true,
  "roots": [
    { "provider": "codex", "path": "D:/Agent Data/codex" },
    { "provider": "claude", "path": "/home/josh/.claude", "distro": "Ubuntu", "user": "josh" }
  ]
}
```

Restart the dashboard after editing its configuration. Arbitrary roots hidden only in another process's private environment cannot be guaranteed. This setting adds source directories; it never connects to or controls an individual session.

## Privacy and limitations

Routine metric collection is deterministic and local. **Enabled AI assessments send the selected task's bounded, redacted evidence to the chosen provider through its installed authenticated CLI and consume that provider's allowance.** Turn automatic assessment off to stop recurring model calls. The browser loads only bundled assets/system fonts from this local origin. Host/Origin checks, strict same-site HttpOnly browser authorization, a restrictive content policy, and tightly scoped observer preference/refresh endpoints protect the local API. Titles and paths are rendered as text. Recognizable secrets are redacted before caching or display; the dashboard does not read authentication or credential stores.

The dashboard's own SQLite cache is `.agent-monitor/cache.sqlite`. It contains normalized observations and transactional ingestion checkpoints. Provider files and databases are read-only. Filesystem activity is reconciled by polling, including sleep/resume, rotation, truncation, replacement and partial writes. Large histories backfill progressively; partial coverage is labeled. The browser uses one SSE connection with heartbeat and full-snapshot resynchronization.

Build replacement uses an instance-specific private launcher key stored in `.agent-monitor/server-process.json`; it is never sent to browser code. A legacy dashboard without this protocol is replaced only after its loopback listener, exact Node executable/server command and stable OS creation identity are verified. If Windows prevents that verification, startup reports the condition and leaves the process untouched. No executable-name-wide termination is used.

Claude subscription allowance has no supported ordinary discovery interface here and is shown unavailable. A dated local official-pricing registry estimates response-scoped API-equivalent cost, including provider-specific cache categories and recognized tiers. Unknown models or cache-write TTLs produce a labeled priced subtotal and coverage. These are not subscription invoices. Native last-reported branch and current read-only Git branch are separate; detached HEAD and non-Git folders are explicit. Main, descendant-only and inclusive usage preserve unavailable categories and avoid inherited-history duplication. Workspace-wide Git changes are not attributed to a particular session. Recent transcript activity does not establish process liveness. See the source documents for detailed semantics:

- [Codex capabilities and sources](docs/CODEX-SOURCES.md)
- [Claude capabilities and sources](docs/CLAUDE-SOURCES.md)
- [Ingestion guarantees](docs/INGESTION.md)
- [Verification and live-environment limits](docs/VERIFICATION.md)
- [Observer execution and isolation](docs/OBSERVER-SOURCES.md)
- [Missing-data and timestamp investigation](docs/SOURCE-INVESTIGATION.md)
- [Timestamp normalization and timezone regressions](docs/TIMESTAMPS.md)

To stop the dashboard, end its Node process in Task Manager (its command line ends in this folder's `dist\server\main.js`). This has no effect on Codex or Claude processes. There is deliberately no provider-control API.
