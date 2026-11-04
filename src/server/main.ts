import path from 'node:path';
import { CacheStore } from './store.js';
import { Collector } from './collector.js';
import { loadConfig } from './discovery.js';
import { createApp, APP_ID } from './app.js';
import { createCodexAdapter } from '../providers/codex/index.js';
import { createClaudeAdapter } from '../providers/claude/index.js';
import { ObserverService } from './observer/service.js';
import { createObserverWorker } from './observer/worker.js';
import { readBuildIdentity, createLifecycle, writeProcessRecord } from './lifecycle.js';

const workspace = path.resolve(process.env.AGENT_MONITOR_WORKSPACE || process.cwd());
const config = await loadConfig(workspace);
const port = Number(process.env.AGENT_MONITOR_PORT) || config.port || 4317;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid dashboard port');
const build = await readBuildIdentity(workspace);
// A reused instance owns its cache/checkpoints. Probe before running cache migrations.
const existingInstance = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }).then(r => r.ok ? r.json() : null).catch(() => null) as { app?: string; workspace?: string; buildId?: string } | null;
if (existingInstance?.app === APP_ID && existingInstance.workspace === workspace) {
  if (existingInstance.buildId !== build.id) throw new Error('An older Agent Monitor build is running. Open Start-AgentMonitor.cmd to replace that dashboard instance safely.');
  console.log(`Agent Monitor already running at http://127.0.0.1:${port}`); process.exit(0);
}
const store = new CacheStore(path.join(workspace, '.agent-monitor/cache.sqlite'));
store.migrateReducers('task-evidence-v2');
const collector = new Collector(store, config, root => root.provider === 'codex' ? createCodexAdapter() : createClaudeAdapter());
collector.current.build = build;
const observer = new ObserverService(store, createObserverWorker(workspace));
observer.on('change', state => collector.setObserver(state));
collector.on('snapshot', snapshot => observer.observe(snapshot));
const clientDir = path.join(workspace, 'dist/client');
let app: Awaited<ReturnType<typeof createApp>>;
let closing = false;
const close = async () => { if (closing) return; closing = true; await observer.close(); await collector.close(); app.server.closeAllConnections(); await app.close(); store.close(); process.exit(0); };
const lifecycle = createLifecycle(build, () => { void close(); });
app = await createApp({ collector, port, clientDir, workspace, observer, lifecycle });
try { await app.listen({ port, host: '127.0.0.1' }); }
catch (e) {
  await observer.close(); await collector.close(); store.close();
  if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    const existing = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => null) as { app?: string; workspace?: string; buildId?: string } | null;
    if (existing?.app === APP_ID && existing.workspace === workspace && existing.buildId === build.id) { console.log(`Agent Monitor already running at http://127.0.0.1:${port}`); process.exit(0); }
  }
  throw e;
}
try { await writeProcessRecord(workspace, port, lifecycle); }
catch (error) { await observer.close(); await collector.close(); await app.close(); store.close(); throw error; }
console.log(`Agent Monitor: http://127.0.0.1:${port}`);
console.log('Local deterministic collection; selected-task AI assessments use isolated CLI workers.');
void observer.start().catch(error => { console.error('Observer capability detection failed:', error instanceof Error ? error.message : 'Unknown error'); });
void collector.start().catch(error => { console.error('Collector startup failed:', error instanceof Error ? error.message : 'Unknown error'); });
process.on('SIGINT', close); process.on('SIGTERM', close);
