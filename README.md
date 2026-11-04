# Agent Monitor

A local, passive dashboard for existing Codex CLI and Claude Code sessions. Start the dashboard once and continue launching your agents normally. It does not resume, attach, submit input, change agent settings, or launch a provider daemon.

## Requirements

- Windows 11 with its built-in Windows PowerShell.
- Node.js **22.13 or newer on a supported LTS release**, with **npm 10 or newer**. Install Node with its npm component; `node` and `npm` must be on `PATH`.
- Codex CLI or Claude Code already installed and used normally. The dashboard uses their existing local session sources and CLI-owned authentication.
- Internet access for the first dependency installation and later dependency updates. Routine metric collection is local; enabled AI assessments use the selected provider as described below.

Git is needed only for the clone/update route. No administrator access, system service, firewall change, Docker, API key, or `.env` file is required.

## Get a copy and start

Choose a permanent, writable application folder. Paths containing spaces are supported.

### Clone with Git

Open PowerShell in the parent folder where you want the application:

```powershell
git clone https://github.com/You-Know-Its-Me-Studios/AgentMonitor.git "Agent-Monitor"
Set-Location -LiteralPath ".\Agent-Monitor"
.\Start-AgentMonitor.cmd
```

### Download ZIP

1. Download the repository ZIP and use Windows **Extract All** to unpack it into a permanent folder.
2. Open the extracted application folder containing `package.json`, `README.md`, and `Start-AgentMonitor.cmd`. The ZIP may contain an additional outer folder.
3. Double-click **Start-AgentMonitor.cmd**. From a terminal already in that folder, the equivalent command is:

```powershell
.\Start-AgentMonitor.cmd
```

Git clones and GitHub **Code → Download ZIP** are source downloads. They do not contain installed dependencies or compiled output. There is no packaged executable or executable installer; the included launcher prepares the source on first use.

On first launch, `scripts/Setup-AgentMonitor.ps1` checks Node/npm, installs the locked dependencies with `npm ci`, creates the production build, and attempts to create a Desktop shortcut for this copy. Later launches install again when dependency inputs change and rebuild when application source or build inputs change. Content fingerprints detect ZIP updates without relying on file dates. Setup uses this copy's folder; no original developer paths are needed. Installation/build progress and failures are recorded in `.agent-monitor\logs\setup.log`.

The launcher starts the local backend, waits for readiness, and opens **http://127.0.0.1:4317** in your browser. Existing sessions appear automatically. Continue starting Codex and Claude normally; there is no subsequent session connection step.

Repeated launches reuse the matching running dashboard. After a rebuild, the launcher verifies and replaces the older dashboard instance for this exact folder before opening the new build. Provider processes are untouched. Startup failures identify logs under `.agent-monitor\logs`.

### Create a Desktop shortcut

Generate a shortcut on the computer that will run the application:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-DesktopShortcut.ps1
```

This creates **Agent Monitor.lnk** on the current user's Desktop and points it to this application folder. A shortcut is machine- and folder-specific; recreate it after moving the folder or changing computers. Do not distribute an existing `.lnk` from another installation. The local PowerShell/VBScript launchers and bundled icon support the shortcut; this project does not provide an executable installer or a system service. Nothing is added to Windows startup.

## Update an installation

For a Git clone, open PowerShell in its application folder:

```powershell
git pull --ff-only
.\Start-AgentMonitor.cmd
```

Keep local configuration and `.agent-monitor` data in place. Setup applies `npm ci` when the dependency installation or lockfile inputs change, rebuilds changed source, and the launcher selects the matching dashboard build. Git may require you to resolve your own source edits before pulling; the launcher does not discard them.

For a ZIP update, stop the old dashboard as described below, extract the new ZIP into a new permanent folder, and start that folder's `Start-AgentMonitor.cmd`. Copy your local `agent-monitor.config.json` if you use one. To retain dashboard history and observer settings, copy `.agent-monitor/cache.sqlite` and any matching `cache.sqlite-wal` / `cache.sqlite-shm` files only after the old dashboard has stopped. Do not copy old process/instance records, `node_modules`, or `dist`; the new copy prepares its own installation. Recreate the Desktop shortcut from the new folder.

## Manual setup and development

To prepare dependencies and the production build without opening the dashboard:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Setup-AgentMonitor.ps1
```

The direct development commands are:

```powershell
npm ci
npm run build
npm start
```

`npm ci` reproduces `package-lock.json`; rerun it after dependency/lockfile changes. Rebuild after source changes. `npm start` starts the compiled server in the terminal; open its localhost address yourself. `npm run dev` builds and watches the compiled backend. `npm run dev:ui` watches frontend assets only. The production frontend and API share one loopback origin.

Past verification procedures and results are recorded in [verification](docs/VERIFICATION.md). Setup and ordinary startup do not run the test suite.

## What appears

- Existing and newly created native sessions, with stable identities and native names. Renames update the existing tab and selected browser title. New sessions do not steal selection. Refresh preserves selection.
- Model, reported effort, project, branch, cwd, timings, activity, reported tokens, cached input, reasoning where available, tool outcomes, attributable edits, and child-agent usage.
- Separate context occupancy, current-turn consumption, lifetime consumption, and shared account allowance windows. Unknown metrics remain unavailable. Expired allowance snapshots remain stale until a fresh observation arrives.
- Searchable local history, archived sessions, and provenance tooltips. Subagents are nested beneath their parent.
- Source-aware runtime labels and visible subagent activity timestamps. A recent transcript is labeled activity evidence rather than verified Running. The optional **Activity** drawer contains the newest-first event timeline; it does not occupy the overview. Session tabs wrap within their space, with explicit access to additional sessions instead of an empty inner scrollbar.
- The configured CLI agent asks an ETA subagent “How much remaining time” for the selected current task. The dashboard displays the subagent's duration or range without padding or widening it. Active tasks require an estimate from the subagent. A single duration stays a single value. Conversation age is kept separate from current-task elapsed time.

## Task observer and Timing & Progress

The compact **Timing & Progress** panel shows ETA, confidence, estimate age, current-task elapsed time, stage and a short blocker, with automatic assessment, interval and **Refresh now** controls. **Assessment details** opens the full report in a same-page drawer. **Worker settings** opens provider/model/effort, timeout and timezone controls without moving the overview. Session details, full tool/subagent lists, token trends and event history are also available in drawers. Automatic assessment defaults to one minute and applies to the selected active top-level conversation. Settings and previous assessments persist in the local cache. Historical, completed and explicitly paused tasks do not receive recurring assessments.

Both installed Codex and Claude CLIs can ask a subagent about either provider's conversation. The backend accepts the completed subagent’s response as the ETA; a coordinator’s own estimate is rejected. The backend supplies a bounded packet of public task instructions, corrections, plans, recent progress, tool/build/test results, subagent evidence and source freshness. It does not assume the observer inherits the working agent's context. Task identity and scope revisions reject late obsolete results. Native runtime state and AI-inferred task state remain separate.

The backend owns one scheduler for all browser windows, coalesces refresh requests, permits one worker per session with a small global limit, enforces timeouts, skips catch-up bursts after sleep and backs off on errors. Previous results stay visible during refresh or failure. An exceeded estimate is labeled rather than silently counting down to zero. Blocked estimates describe active work after the dependency clears.

Workers use a new noninteractive execution, a neutral application-owned directory, a short delegation request through stdin, and bounded task evidence supplied directly in a temporary subagent role file. This avoids making the coordinator regenerate the transcript in its tool call. Per-run customization/tool restrictions, ephemeral/no-persistence settings, and CLI-owned authentication remain in effect. They never resume or send input to the monitored conversation. Observer consumption is separate from monitored usage, while native account allowances still reflect actual shared account consumption. No login tokens are extracted. Managed administrative policy remains enforced by the CLI.

Dates default to the browser's IANA timezone; the optional override accepts names such as `America/New_York`. Activity tooltips distinguish original occurrence, ingestion and source checks. Reading old records or receiving a heartbeat cannot make native activity fresh. Source freshness is shown separately from browser stream connectivity.

Codex prefers a read-only observer connection to its **existing** shared daemon. Where that socket is unavailable, native read-only metadata and rollouts still show sessions and metrics, with unconfirmed runtime status clearly labeled. Claude prefers the supported `claude agents --json` listing and supplements it with transcripts. File modification alone is never presented as proof that an agent is running.

## Source roots and WSL

Default roots are `%USERPROFILE%\.codex` and `%USERPROFILE%\.claude`; discoverable `CODEX_HOME` and `CLAUDE_CONFIG_DIR` roots are included as well. Codex's configured SQLite location is capability-detected. Default paths are never replaced by an additional configured root.

On Windows, only distributions reported by `wsl --list --running --quiet` are inspected. Read-only bounded Python 3 helpers run in their Linux user namespace. Stopped distributions are skipped. WSL access failures are visible in Diagnostics; native Windows observation continues.

Default settings require no configuration file. For a custom port or an accessible source root that cannot be discovered from this process's environment, copy the included template once, then edit your local copy:

```powershell
Copy-Item -LiteralPath .\agent-monitor.config.example.json -Destination .\agent-monitor.config.json
```

The template uses port `4317`, a two-second collection interval, WSL discovery enabled, and no additional roots. Add only roots you need. This example illustrates the supported fields; replace the WSL placeholders with your own running distribution and Linux user:

```json
{
  "port": 4317,
  "pollMs": 2000,
  "wsl": true,
  "roots": [
    { "provider": "codex", "path": "D:/Agent Data/codex" },
    { "provider": "claude", "path": "/home/YOUR_LINUX_USER/.claude", "distro": "YOUR_DISTRO", "user": "YOUR_LINUX_USER" }
  ]
}
```

Do not overwrite an existing local configuration when updating. Restart only the dashboard after changing it. Ports must be from `1024` to `65535`; a configured port changes the localhost address accordingly. Arbitrary roots hidden only in another process's private environment cannot be guaranteed. This setting adds source directories; it never connects to or controls an individual session.

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

## Stop the dashboard

Closing its browser tab leaves monitoring running. If you used `npm start`, press **Ctrl+C** in that terminal. For a shortcut-launched instance, open Task Manager's **Details** tab, enable the **Command line** column, and end only the `node.exe` process whose command line names this installation's `dist\server\main.js`. Do not end every Node, Codex, or Claude process. Stopping the dashboard does not stop the monitored sessions. There is deliberately no provider-control API.
