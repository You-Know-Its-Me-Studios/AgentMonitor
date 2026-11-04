import path from 'node:path';
import { CacheStore } from './store.js';
import { Collector } from './collector.js';
import { loadConfig } from './discovery.js';
import { createApp, APP_ID } from './app.js';
import { createCodexAdapter } from '../providers/codex/index.js';
import { createClaudeAdapter } from '../providers/claude/index.js';

const workspace = path.resolve(process.env.AGENT_MONITOR_WORKSPACE || process.cwd());
const config = await loadConfig(workspace);
const port = Number(process.env.AGENT_MONITOR_PORT) || config.port || 4317;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid dashboard port');
const store = new CacheStore(path.join(workspace, '.agent-monitor/cache.sqlite'));
const collector = new Collector(store, config, root => root.provider === 'codex' ? createCodexAdapter() : createClaudeAdapter());
const clientDir = path.join(workspace, 'dist/client');
const app = await createApp({ collector, port, clientDir, workspace });
try { await app.listen({ port, host: '127.0.0.1' }); }
catch (e) {
  await collector.close(); store.close();
  if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    const existing = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.json()).catch(() => null) as { app?: string; workspace?: string } | null;
    if (existing?.app === APP_ID && existing.workspace === workspace) { console.log(`Agent Monitor already running at http://127.0.0.1:${port}`); process.exit(0); }
  }
  throw e;
}
console.log(`Agent Monitor: http://127.0.0.1:${port}`);
console.log('Passive local observation; provider configuration and sessions are unchanged.');
void collector.start().catch(error => { console.error('Collector startup failed:', error instanceof Error ? error.message : 'Unknown error'); });
let closing = false;
const close = async () => { if (closing) return; closing = true; await collector.close(); app.server.closeAllConnections(); await app.close(); store.close(); process.exit(0); };
process.on('SIGINT', close); process.on('SIGTERM', close);
