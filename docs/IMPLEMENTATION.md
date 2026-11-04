# Agent Monitor implementation record

Scope: local, passive observation of existing Codex and Claude sessions. No provider configuration changes or control actions. User explicitly authorized tests, builds, browser verification, and local startup.

Stack: Node 22 LTS, TypeScript, Fastify, React/Vite, built-in SQLite, one SSE stream. Shared contracts are `src/shared/types.ts` and `src/shared/adapter.ts`; the main agent owns these contracts and orchestration.

Identity is provider + configuration/runtime namespace + native conversation ID. Provider data stays read-only. The cache stores normalized metrics, source reducer state, and transactional byte checkpoints. Source text is not logged.

Initial observations: empty directory, no Git repository; installed Node 22.23.4, npm 10.9.9, Codex 0.166.0, Claude Code 2.1.318. The sandbox denies the Codex control socket and WSL enumeration. Persisted records remain accessible. Runtime discovery must surface these capability limits and retry passively.

Acceptance: automatic preexisting/new session discovery, stable native names and selection, truthful runtime and usage accounting, lifecycle-safe ingestion, one-origin loopback privacy, meaningful automated and real UI verification. See capability documents for verified provider evidence and final README for commands.

Final handoff: implementation and production artifacts are present. Shared adapters, backend, frontend, persistence, launcher, shortcut installer and synthetic/HTTP tests are implemented. Real API observation confirmed the current Codex conversation and one live idle Claude session. Last combined tests passed 63; later focused Codex and SSE checks passed separately. Browser checks and actual Desktop installation were blocked by the environment. The user then revoked further launches; no more application/browser/shortcut/test launches were performed. See `docs/VERIFICATION.md` for exact evidence and limitations.

## Current observer update (November 2026)

The user's subsequent request supersedes the no-model rule for observer assessment, authorizes automated checks/build and one bounded real assessment, and leaves visual inspection to the user. No browser, visual-audit, launcher or working-agent control is needed for this update.

Shared observer/task contracts are `src/shared/observer.ts`. The backend supplies bounded public task evidence to a separately tracked Codex/Claude execution. It owns scheduling, settings persistence, task/request identity, validation, normalized storage and SSE. The selected active session is the default scope. Provider collection remains deterministic and read-only.

Reducers use `task-evidence-v2`; production startup invalidates and rebuilds only dashboard-owned source checkpoints so old projections gain current-task data. Current-tail observation repairs lag while bounded historical backfill continues. Source occurrence, ingestion, checking and assessment instants remain distinct. The application preserves its existing design, automatic discovery, single-origin API and launcher.

Final current-update handoff: 161 automated tests in 19 files passed, including the opt-in real current-source trace; type checking and production build passed. Both worker capability/isolation preflights passed. Real assessment success could not be verified in this sandbox: Codex internal client initialization was denied by Windows IPC permissions, and the bounded Claude attempt timed out at 60 seconds. Those failures are surfaced without invented estimates. No dashboard/browser launch or working-session control occurred. Restart the dashboard normally to load the rebuilt artifacts.

## Stale running build and screenshot corrections

The earlier delivery missed the launcher handoff: production files were rebuilt, but a healthy old process was reused without comparing versions, so the user reopened old UI code. Builds now fingerprint backend and frontend into `dist/build.json`. The launcher reuses only matching builds and replaces a stale owned dashboard through a private instance-bound stop protocol. Legacy migration validates loopback ownership, exact server command and process creation identity before touching that dashboard alone. No dashboard/browser is launched by the implementation agent.

Recent activity is now one normalized newest-first timeline. Subagents show visible event times, ages and source conditions. Runtime badges distinguish actual runtime confirmation, inferred activity and source failure. Tabs wrap without an internal scrollbar and retain keyboard navigation, explicit overflow access, stable identity and selection. The user requested `git add .`, change-focused commits and push to `main` for completed work and future changes.

Final handoff for these corrections: **187 tests in 22 files passed**, including the passive current-source check; type checking and production build passed. Targeted read-only native paginated user-message retrieval preserves the current task when its instructions precede a large rollout output gap. The exact Eastern timestamp and AM/PM regressions pass. Local Git staging was blocked by read-only `.git` metadata; the connected GitHub API provides the authorized `main` commit without changing protected local metadata.
