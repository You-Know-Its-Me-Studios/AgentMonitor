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
import { logError } from './errors.js';

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
observer.on('change', state => { try { collector.setObserver(state); } catch (error) { logError('Observer snapshot delivery', error); } });
collector.on('snapshot', snapshot => { try { observer.observe(snapshot); } catch (error) { logError('Observer evidence delivery', error); } });
// Bootstrap and selection must see the same cached session identities. Collection
// is still initializing, so observe() cannot schedule an assessment from this cache.
observer.observe(collector.current);
const clientDir = path.join(workspace, 'dist/client');
let app: Awaited<ReturnType<typeof createApp>>;
let closing = false;
const close = async () => { if (closing) return; closing = true; await observer.close(); await collector.close(); app.server.closeAllConnections(); await app.close(); store.close(); process.exit(0); };
const requestClose = () => { void close().catch(error => { logError('Dashboard shutdown', error); }); };
const lifecycle = createLifecycle(build, requestClose);
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
console.log(`${new Date().toISOString()} Agent Monitor: http://127.0.0.1:${port} (PID ${process.pid}, build ${build.id}, instance ${lifecycle.instanceId})`);
console.log('Local deterministic collection; selected-task AI assessments use isolated CLI workers.');
void observer.start().catch(error => { logError('Observer startup', error); });
void collector.start().catch(error => { logError('Collector startup', error); });
process.on('SIGINT', requestClose); process.on('SIGTERM', requestClose);
