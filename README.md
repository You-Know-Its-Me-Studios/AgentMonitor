# Agent Monitor

A local, passive dashboard for existing Codex CLI and Claude Code sessions. Start the dashboard once and continue launching your agents normally. It does not resume, attach, submit input, change agent settings, or launch a provider daemon.

## Start on Windows

The production launcher is:

```powershell
.\Start-AgentMonitor.cmd
```

Dashboard: **http://127.0.0.1:4317**

A ready-to-copy **Agent Monitor.lnk** is included in this folder. The shortcut starts the production Node server hidden, waits for readiness, and opens your default browser. Repeated launches reuse this folder's existing instance. It works without a development terminal and after reboot; it does not auto-start on login. Its target is the local hidden launcher, and its icon is bundled in `scripts/agent-monitor.ico`.

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

`npm run dev` builds and watches the compiled backend. Run `npm run build` after source edits to refresh it. `npm run dev:ui` watches and rebuilds frontend assets; restart the backend when the asset manifest changes. The production frontend and API share one loopback origin. Rebuild after changing source before using the shortcut.

Browser verification commands and results are recorded in [verification](docs/VERIFICATION.md). Parser, accounting, file-lifecycle, discovery, API security, launcher, and browser tests use isolated synthetic provider roots. No test mutates your provider history.

## What appears

- Existing and newly created native sessions, with stable identities and native names. Renames update the existing tab and selected browser title. New sessions do not steal selection. Refresh preserves selection.
- Model, reported effort, project, branch, cwd, timings, activity, reported tokens, cached input, reasoning where available, tool outcomes, attributable edits, and child-agent usage.
- Separate context occupancy, current-turn consumption, lifetime consumption, and shared account allowance windows. Unknown metrics remain unavailable. Expired allowance snapshots remain stale until a fresh observation arrives.
- Searchable local history, archived sessions, source diagnostics, and provenance tooltips. Subagents are nested beneath their parent.
- Conditional ETA only from sufficient explicit checklist and comparable observed step durations. Otherwise the timing panel shows **Not enough data yet** alongside useful elapsed/activity data.

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

Normal operation performs no model inference and uploads no conversation data. The browser loads only bundled assets/system fonts from this local origin. Host/Origin checks, strict same-site HttpOnly browser authorization, a restrictive content policy, and read-only endpoints protect the local API. Titles and paths are rendered as text, and recognizable secrets are redacted before caching or display. Authentication and credential stores are not read.

The dashboard's own SQLite cache is `.agent-monitor/cache.sqlite`. It contains normalized observations and transactional ingestion checkpoints. Provider files and databases are read-only. Filesystem activity is reconciled by polling, including sleep/resume, rotation, truncation, replacement and partial writes. Large histories backfill progressively; partial coverage is labeled. The browser uses one SSE connection with heartbeat and full-snapshot resynchronization.

Claude subscription allowance has no supported ordinary discovery interface here and is shown unavailable. API-equivalent cost requires known pricing and correctly scoped usage; it is unavailable when those requirements are unmet and is never represented as a subscription invoice. Workspace-wide Git changes are not attributed to a particular session. Recent transcript activity does not establish process liveness. See the source documents for detailed semantics:

- [Codex capabilities and sources](docs/CODEX-SOURCES.md)
- [Claude capabilities and sources](docs/CLAUDE-SOURCES.md)
- [Ingestion guarantees](docs/INGESTION.md)
- [Verification and live-environment limits](docs/VERIFICATION.md)

To stop the dashboard, end its Node process in Task Manager (its command line ends in this folder's `dist\server\main.js`). This has no effect on Codex or Claude processes. There is deliberately no provider-control API.
