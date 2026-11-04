# Agent Monitor implementation record

Scope: local, passive observation of existing Codex and Claude sessions. No provider configuration changes or control actions. User explicitly authorized tests, builds, browser verification, and local startup.

Stack: Node 22 LTS, TypeScript, Fastify, React/Vite, built-in SQLite, one SSE stream. Shared contracts are `src/shared/types.ts` and `src/shared/adapter.ts`; the main agent owns these contracts and orchestration.

Identity is provider + configuration/runtime namespace + native conversation ID. Provider data stays read-only. The cache stores normalized metrics, source reducer state, and transactional byte checkpoints. Source text is not logged.

Initial observations: empty directory, no Git repository; installed Node 22.23.4, npm 10.9.9, Codex 0.166.0, Claude Code 2.1.318. The sandbox denies the Codex control socket and WSL enumeration. Persisted records remain accessible. Runtime discovery must surface these capability limits and retry passively.

Acceptance: automatic preexisting/new session discovery, stable native names and selection, truthful runtime and usage accounting, lifecycle-safe ingestion, one-origin loopback privacy, meaningful automated and real UI verification. See capability documents for verified provider evidence and final README for commands.

Final handoff: implementation and production artifacts are present. Shared adapters, backend, frontend, persistence, launcher, shortcut installer and synthetic/HTTP tests are implemented. Real API observation confirmed the current Codex conversation and one live idle Claude session. Last combined tests passed 63; later focused Codex and SSE checks passed separately. Browser checks and actual Desktop installation were blocked by the environment. The user then revoked further launches; no more application/browser/shortcut/test launches were performed. See `docs/VERIFICATION.md` for exact evidence and limitations.
