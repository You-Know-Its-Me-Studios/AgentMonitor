import type { AdapterContext, AdapterResult, FileInfo, ProviderAdapter } from '../../shared/adapter.js';
import { emptySession, metric, sessionKey, type Allowance, type Diagnostic, type Session } from '../../shared/types.js';
import { initialCodexState, iso, quotaFromSnapshot, reduceCodex, sessionFromState, string, usage, type CodexState } from './parser.js';
import { ObserverProxy } from './runtime.js';
import { readMetadata, type ThreadMetadata } from './sqlite.js';

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
export function parseDaemonProbe(stdout: string): { version: string; socket: string | null } {
  const value = JSON.parse(stdout);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid daemon probe');
  const version = string(value.appServerVersion ?? value.app_server_version);
  if (!version) throw new Error('Unsupported daemon version response');
  const socket = string(value.socketPath ?? value.socket_path);
  if (socket?.includes('\0')) throw new Error('Invalid daemon socket path');
  return { version, socket };
}
async function discover(context: AdapterContext, directory: string): Promise<FileInfo[]> {
  const files: FileInfo[] = [], queue = [directory]; let visited = 0;
  while (queue.length && visited++ < 20000) { const dir = queue.shift()!; const entries = await context.io.list(dir); for (const entry of entries) { if (entry.isDirectory) queue.push(entry.path); else if (entry.path.endsWith('.jsonl')) files.push(entry); } }
  return files;
}
function diagnostic(context: AdapterContext, code: string, message: string, level: Diagnostic['level'] = 'info'): Diagnostic { return { provider: 'codex', namespace: context.namespace, level, code, message, at: context.now }; }
function applyMetadata(session: Session, row: ThreadMetadata): void {
  if (row.name || row.title) { session.name = row.name ?? row.title!; session.nameSource = row.name ? 'native session name' : 'native generated title'; }
  session.startedAt ??= row.startedAt; if (row.lastAt && (!session.lastActivityAt || row.lastAt > session.lastActivityAt)) session.lastActivityAt = row.lastAt;
  session.cwd ??= row.cwd; session.project ??= row.cwd?.replace(/\\/g,'/').split('/').pop() ?? null; session.branch ??= row.branch;
  if (row.model) session.model = metric(row.model,'Codex native state database','session','reported',undefined,row.lastAt ?? new Date(0).toISOString());
  if (row.effort) session.effort = metric(row.effort,'Codex native state database','session','reported',undefined,row.lastAt ?? new Date(0).toISOString());
  session.archived = row.archived; if (row.parent) session.parentId = sessionKey('codex',session.namespace,row.parent);
}
function applyRuntime(session: Session, thread: any, context: AdapterContext, loaded: boolean): void {
  const status = thread.status; const type = typeof status === 'string' ? status : status?.type; const flags: string[] = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
  session.runtime = { reachable: true, loaded: loaded && type !== 'notLoaded', attachment: 'unknown', pid: null, processStartedAt: null, observedAt: context.now };
  let state: Session['state']['value'] = 'unknown';
  if (type === 'active') state = flags.some(f => /approval/i.test(f)) ? 'approval' : flags.some(f => /input/i.test(f)) ? 'input' : 'running';
  else if (type === 'idle') state = 'idle'; else if (type === 'notLoaded') state = 'historical';
  session.state = metric(state,'Existing Codex app-server observer','runtime',state === 'unknown' ? 'unavailable' : 'reported',state === 'unknown' ? 'Runtime status format is unsupported' : undefined,context.now);
  if (string(thread.name)) { session.name = thread.name; session.nameSource = 'native live name'; }
  if (string(thread.model)) session.model = metric(thread.model,'Existing Codex app-server','session','reported',undefined,context.now);
  if (string(thread.reasoningEffort)) session.effort = metric(thread.reasoningEffort,'Existing Codex app-server','session','reported',undefined,context.now);
  session.cwd = string(thread.cwd) ?? session.cwd; session.branch = string(thread.gitInfo?.branch) ?? session.branch;
  session.forkedFromId = string(thread.forkedFromId) ? sessionKey('codex',context.namespace,thread.forkedFromId) : session.forkedFromId;
}

export function createCodexAdapter(): ProviderAdapter {
  const normalized = new Map<string,Session>(); const states = new Map<string,CodexState>(); const proxy = new ObserverProxy();
  let lastScan = 0, lastProbe = 0, lastRuntime = 0, lastAllowance = 0, rotation = 0;
  let files: FileInfo[] = [], proxyReady = false, runtimeFailure = 'Existing daemon has not been probed';
  let liveThreads = new Map<string,any>(), liveAllowances: Allowance[] = [];
  let metadata: ThreadMetadata[] = []; let metadataAvailable = false;
  let names: Record<string,{name: string; at: string}> = {};
  let namespace = '';
  return {
    provider: 'codex',
    async poll(context): Promise<AdapterResult> {
      if (namespace && namespace !== context.namespace) throw new Error('A Codex adapter instance belongs to one root namespace'); namespace = context.namespace;
      const now = Date.parse(context.now); const diagnostics: Diagnostic[] = [];
      if (!lastProbe || now - lastProbe > 30_000) {
        lastProbe = now;
        try {
          const result = await context.command('codex',['app-server','daemon','version'],4000);
          if (result.code !== 0) { proxyReady = false; runtimeFailure = /10013|forbidden|permission|Access is denied/i.test(result.stderr) ? 'The existing Codex daemon control socket is not accessible to this process. Persisted session observation is active.' : 'No supported existing Codex daemon is reachable. Persisted session observation is active.'; proxy.close(); }
          else {
            const probe = parseDaemonProbe(result.stdout);
            await proxy.connect(context,probe.socket ?? undefined); proxyReady = true; runtimeFailure = '';
          }
        } catch { proxyReady = false; runtimeFailure = 'Existing Codex daemon observation is unavailable or returned an unsupported response. Persisted observation is active.'; proxy.close(); }
      }
      // Observe before enumeration, then reconcile loaded IDs again to close startup races.
      if (proxyReady && (!lastRuntime || now-lastRuntime >= 3000)) {
        lastRuntime = now;
        // Old notifications must not override a newer authoritative reconciliation read.
        proxy.notifications.clear();
        try {
          const first = await proxy.request('thread/loaded/list'); const ids = Array.isArray(first?.data) ? first.data.filter((x: unknown) => typeof x === 'string') as string[] : [];
          const next = new Map<string,any>();
          // State-db-only listing is optional. Never fall back to a repair scan.
          try { const list = await proxy.request('thread/list',{limit:100,useStateDbOnly:true,sortKey:'updated_at'}); if (Array.isArray(list?.data)) for (const thread of list.data) if (typeof thread?.id === 'string') next.set(thread.id,thread); } catch { diagnostics.push(diagnostic(context,'codex-state-list-unsupported','State-database-only runtime listing is unsupported; native files supply history.')); }
          const second = await proxy.request('thread/loaded/list'); if (Array.isArray(second?.data)) for (const id of second.data) if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
          for (let offset = 0; offset < Math.min(ids.length,512); offset += 8) await Promise.all(ids.slice(offset,offset+8).map(async id => { try { const read = await proxy.request('thread/read',{threadId:id,includeTurns:false}); if (read?.thread?.id === id) next.set(id,{...read.thread,__loaded:true}); } catch { diagnostics.push(diagnostic(context,'codex-thread-read-unavailable','A loaded thread could not be read; it will be reconciled again.')); } }));
          liveThreads = next;
          if (!lastAllowance || now-lastAllowance >= 30_000) {
            lastAllowance = now;
            try { const result = await proxy.request('account/rateLimits/read'); const entries = result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object' ? Object.values(result.rateLimitsByLimitId) : [result?.rateLimits]; liveAllowances = entries.flatMap(value => quotaFromSnapshot(value,context.namespace,'Codex account/rateLimits/read',context.now,context.now)); } catch { diagnostics.push(diagnostic(context,'codex-account-allowance-unavailable','The existing daemon does not expose a readable account allowance snapshot.')); }
          }
        } catch { proxyReady = false; proxy.close(); liveThreads.clear(); diagnostics.push(diagnostic(context,'codex-observer-disconnected','Existing daemon observer disconnected; file observation continues.','warning')); }
      }
      if (!lastScan || now-lastScan >= 10_000) {
        lastScan = now;
        const meta = await readMetadata(context); metadata = meta.threads; metadataAvailable = meta.available;
        if (meta.errors) diagnostics.push(diagnostic(context,'codex-sqlite-partial','Some native metadata databases were locked or had unsupported schemas; they will be retried.'));
        const discovered = await Promise.all([discover(context,context.io.join(context.root,'sessions')),discover(context,context.io.join(context.root,'archived_sessions'))]);
        const byPath = new Map(discovered.flat().map(x => [x.path,x]));
        // Native metadata also discovers rollouts outside the dated directory layout.
        for (const thread of metadata) if (thread.rolloutPath && !byPath.has(thread.rolloutPath)) { const stat = await context.io.stat(thread.rolloutPath); if (stat) byPath.set(thread.rolloutPath,stat); }
        files = [...byPath.values()].sort((a,b) => b.mtimeMs-a.mtimeMs);
      }
      const indexPath = context.io.join(context.root,'session_index.jsonl');
      if (await context.io.stat(indexPath)) {
        const index = await context.ingest(indexPath,() => ({} as Record<string,{name: string; at: string}>),(value,record) => { const id = string(record.id); const name = string(record.thread_name ?? record.name); const at = iso(record.updated_at) ?? ''; if (id && name && id !== 'prototype' && !Object.hasOwn(Object.prototype,id)) value[id] = {name,at}; }); names = index.state;
        if (!index.complete) diagnostics.push(diagnostic(context,'codex-name-index-backfill','Native session names are being backfilled.'));
      }
      const metadataByPath = new Map(metadata.filter(x => x.rolloutPath).map(x => [x.rolloutPath!,x]));
      // Always update recent sources. Progressively backfill older history with bounded concurrency.
      const priority = files.slice(0,12); const historical = files.slice(12); const batch = [...priority,...historical.slice(rotation,rotation+20)]; rotation = historical.length ? (rotation + 20) % historical.length : 0;
      for (let offset = 0; offset < batch.length; offset += 4) await Promise.all(batch.slice(offset,offset+4).map(async file => {
        const id = metadataByPath.get(file.path)?.id ?? file.path.match(UUID)?.[1]; if (!id) return;
        try {
          const result = await context.ingest(file.path,() => initialCodexState(id),reduceCodex);
          if (!result.state.canonical) return;
          states.set(id,result.state); const session = sessionFromState(result.state,context.namespace,'Codex rollout',context.now);
          session.archived = /(?:^|[\\/])archived_sessions[\\/]/.test(file.path); normalized.set(id,session);
          if (!result.complete) diagnostics.push(diagnostic(context,'codex-backfill','Session history is being backfilled progressively; available metrics may be partial.'));
          if (result.errors) diagnostics.push(diagnostic(context,'codex-json-record-skipped','Malformed persisted records were skipped; complete later records remain observable.','warning'));
        } catch { diagnostics.push(diagnostic(context,'codex-file-unavailable','A session source is temporarily unavailable or locked and will be retried.','warning')); }
      }));
      const sessions = new Map<string,Session>();
      for (const row of metadata) { const session = structuredClone(normalized.get(row.id) ?? emptySession('codex',context.namespace,row.id,'Codex native state database',context.now)); applyMetadata(session,row); sessions.set(row.id,session); }
      for (const [id,value] of normalized) if (!sessions.has(id)) sessions.set(id,structuredClone(value));
      const allowances = new Map<string,Allowance>();
      for (const [id,state] of states) { const session = sessions.get(id); if (!session || !state.quota) continue; const quota = quotaFromSnapshot(state.quota.value,context.namespace,'Codex persisted rate-limit snapshot',state.quota.at,context.now); session.allowanceIds = quota.map(x => x.id); for (const window of quota) { const previous = allowances.get(window.id); if (!previous || window.usedPercent.provenance.observedAt > previous.usedPercent.provenance.observedAt) allowances.set(window.id,window); } }
      for (const window of liveAllowances) { const refreshed = {...window,usedPercent:{...window.usedPercent,provenance:{...window.usedPercent.provenance}}}; if (now-Date.parse(window.usedPercent.provenance.observedAt)>300_000 || window.resetsAt && Date.parse(window.resetsAt)<=now) refreshed.usedPercent.provenance.quality='stale'; allowances.set(window.id,refreshed); }
      for (const [id,thread] of liveThreads) {
        if (!proxyReady) break;
        const session = sessions.get(id) ?? emptySession('codex',context.namespace,id,'Existing Codex app-server',context.now);
        applyRuntime(session,thread,context,thread.__loaded === true); sessions.set(id,session);
      }
      for (const session of sessions.values()) {
        if (!session.runtime.reachable && session.lastActivityAt && now - Date.parse(session.lastActivityAt) < 15 * 60_000) session.state = metric('unknown','Codex persisted observation','runtime','derived','Recently active transcript; runtime and attachment are unconfirmed',session.lastActivityAt);
        if (liveAllowances.length) session.allowanceIds = [...new Set([...session.allowanceIds,...liveAllowances.map(x => x.id)])];
        const title = Object.hasOwn(names,session.nativeId) ? names[session.nativeId] : undefined; if (title && session.nameSource !== 'native live name') { session.name = title.name; session.nameSource = 'native append-only naming index'; }
        const notification = proxy.notifications.get(`thread/name/updated:${session.nativeId}`); if (proxyReady && string(notification?.threadName ?? notification?.name)) { session.name = notification.threadName ?? notification.name; session.nameSource = 'native live name'; }
        const status = proxy.notifications.get(`thread/status/changed:${session.nativeId}`); if (proxyReady && status?.status) applyRuntime(session,{status:status.status},context,status.status.type !== 'notLoaded');
        if (session.runtime.loaded && session.startedAt) session.timing.elapsedMs = metric(Math.max(0,now-Date.parse(session.startedAt)),'Codex existing daemon','session','derived','Wall-clock time since conversation creation',context.now);
        const usageEvent = proxy.notifications.get(`thread/tokenUsage/updated:${session.nativeId}`); if (proxyReady && usageEvent?.tokenUsage) { const total = usage(usageEvent.tokenUsage.total); if (total) session.usage = metric(total,'Codex runtime usage notification','session','reported',undefined,context.now); }
        if (session.parentId) session.name = session.nameSource === 'native ID' ? metadata.find(x => x.id === session.nativeId)?.title ?? session.name : session.name;
      }
      if (!proxyReady) diagnostics.push(diagnostic(context,'codex-runtime-unavailable',runtimeFailure || 'Runtime status is unavailable. Persisted observation remains active.','warning'));
      diagnostics.push(diagnostic(context,'codex-observation-mode',`${metadataAvailable ? 'Native metadata database and rollout' : 'Rollout'} observation; ${files.length} persisted sources discovered. No session is resumed or controlled.`));
      return { sessions: [...sessions.values()], allowances: [...allowances.values()], diagnostics };
    },
    async close() { proxy.close(); }
  };
}
