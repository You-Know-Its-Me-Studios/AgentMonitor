import type { AdapterContext, AdapterResult, FileInfo, ProviderAdapter } from '../../shared/adapter.js';
import { emptySession, metric, sessionKey, type Allowance, type Diagnostic, type Session } from '../../shared/types.js';
import { initialCodexState, iso, quotaFromSnapshot, reduceCodex, sessionFromState, string, usage, type CodexState } from './parser.js';
import { ObserverProxy } from './runtime.js';
import { readMetadata, type ThreadMetadata } from './sqlite.js';
import { canonicalHeader, mergeCodexObservations, readCodexTail } from './tail.js';
import { isObserverWorkspace } from '../../server/task-evidence.js';

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
  // Database recency includes renames/settings and is not a substitute for an ingested event time.
  if(row.startedAt&&(!session.startedAt||row.startedAt<session.startedAt))session.startedAt=row.startedAt;
  session.cwd ??= row.cwd; session.project ??= row.cwd?.replace(/\\/g,'/').split('/').pop() ?? null; session.branch ??= row.branch;
  if (row.model&&(!session.model.value||(row.lastAt??'')>=session.model.provenance.observedAt)) session.model = metric(row.model,'Codex native state database','session','reported',undefined,row.lastAt ?? new Date(0).toISOString());
  if (row.effort&&(!session.effort.value||(row.lastAt??'')>=session.effort.provenance.observedAt)) session.effort = metric(row.effort,'Codex native state database','session','reported',undefined,row.lastAt ?? new Date(0).toISOString());
  session.archived = row.archived; if (row.parent) session.parentId = sessionKey('codex',session.namespace,row.parent);
  if(row.role)session.agentRole=row.role;
}
export function applyRuntime(session: Session, thread: any, context: AdapterContext, loaded: boolean): void {
  const status = thread.status; const type = typeof status === 'string' ? status : status?.type; const flags: string[] = Array.isArray(status?.activeFlags) ? status.activeFlags.filter((flag:unknown)=>typeof flag==='string') : [];
  session.runtime = { reachable: true, loaded: type !== 'notLoaded'&&(loaded||['active','idle','systemError'].includes(type)), attachment: 'unknown', pid: null, processStartedAt: null, observedAt: context.now };
  let state: Session['state']['value'] = 'unknown';
  const malformedFlags=status?.activeFlags!==undefined&&(!Array.isArray(status.activeFlags)||status.activeFlags.some((flag:unknown)=>typeof flag!=='string'));
  if (type === 'active'&&!malformedFlags) state = flags.some(f => /approval/i.test(f)) ? 'approval' : flags.some(f => /input/i.test(f)) ? 'input' : flags.some(f=>/waiting/i.test(f))?'unknown':'running';
  else if (type === 'idle') state = 'idle'; else if (type === 'notLoaded') state = 'historical';
  const reason=state==='approval'?'Existing app-server reports a loaded thread waiting for approval.':state==='input'?'Existing app-server reports a loaded thread waiting for user input.':state==='running'?'Existing app-server reports an active loaded thread.':state==='idle'?'Existing app-server reports an idle loaded thread; idle does not mean the process exited.':state==='historical'?'Existing app-server reports this thread is not loaded; terminal attachment is unknown.':type==='systemError'?'Existing app-server reports a system error; current task state is unknown.':malformedFlags?'Existing app-server returned unsupported active flags; the task state cannot be interpreted.':'Existing app-server returned an unsupported runtime state or waiting condition.';
  session.state = metric(state,'Existing Codex app-server observer','runtime',state === 'unknown' ? 'unavailable' : 'reported',reason,context.now);
  if (string(thread.name)) { session.name = thread.name; session.nameSource = 'native live name'; }
  if (string(thread.model)) session.model = metric(thread.model,'Existing Codex app-server','session','reported',undefined,context.now);
  if (string(thread.reasoningEffort)) session.effort = metric(thread.reasoningEffort,'Existing Codex app-server','session','reported',undefined,context.now);
  session.cwd = string(thread.cwd) ?? session.cwd; session.branch = string(thread.gitInfo?.branch) ?? session.branch;
  session.forkedFromId = string(thread.forkedFromId) ? sessionKey('codex',context.namespace,thread.forkedFromId) : session.forkedFromId;
}
export function newerRuntimeNotification(thread:any,notification:any):boolean{return typeof notification?.__observerSequence==='number'&&notification.__observerSequence>(thread?.__observerSequence??-1);}
export function daemonFailureReason(stderr:string):string {
  if(/10013/.test(stderr))return'Existing Codex daemon control-socket access was denied (Windows 10013); live thread status is unavailable.';
  if(/EPERM|EACCES|forbidden|permission|Access is denied/i.test(stderr))return'Passive Codex daemon observation was denied by the environment; live thread status is unavailable.';
  return'No supported existing Codex daemon is reachable; live thread status is unavailable.';
}
export function applyPersistedRuntimeReason(session:Session,state:CodexState|undefined,context:AdapterContext,failure:string,probeAt:string):void {
  if(session.runtime.reachable)return;
  const recent=!!session.lastActivityAt&&Date.parse(context.now)-Date.parse(session.lastActivityAt)<15*60000;
  const taskEvidence=state?.lastTask==='started'?'Native records show a started turn with no recorded completion.':state?.lastTask==='aborted'?'Native records show an interrupted turn.':state?.lastTask==='complete'?'Native records show the last turn completed; process liveness is unconfirmed.':session.task?.state==='paused'?'The latest public task instructions pause work.':'No current native runtime status has been verified.';
  const reason=`${failure} ${taskEvidence} A daemon process or writer-lock file does not establish this thread is running.`;
  session.state=metric(recent||!session.lastActivityAt?'unknown':'historical','Codex persisted observation','runtime',recent?'derived':session.lastActivityAt?'derived':'unavailable',reason,probeAt);
  if(session.collection)session.collection.reason=`${session.collection.reason}. ${failure}`;
  else session.collection={lastCheckedAt:context.now,ingestedAt:null,evidenceAt:session.lastActivityAt,condition:'unavailable',reason:`Conversation metadata is known; normalized source records have not been recovered. ${failure}`};
}

export function createCodexAdapter(): ProviderAdapter {
  const normalized = new Map<string,Session>(); const states = new Map<string,CodexState>(); const proxy = new ObserverProxy();
  let lastScan = 0, lastProbe = 0, lastRuntime = 0, lastAllowance = 0, rotation = 0;
  let files: FileInfo[] = [], proxyReady = false, runtimeFailure = 'Existing daemon has not been probed';
  let liveThreads = new Map<string,any>(), liveAllowances: Allowance[] = [];
  let metadata: ThreadMetadata[] = []; let metadataAvailable = false;
  let names: Record<string,{name: string; at: string}> = {};
  let namespace = '';
  const tailCache=new Map<string,{identity:string;size:number;mtimeMs:number;generation:number;state:CodexState}>();
  const headers=new Map<string,{identity:string;record:any}>();
  let observerIds=new Set<string>();
  return {
    provider: 'codex',
    async poll(context): Promise<AdapterResult> {
      if (namespace && namespace !== context.namespace) throw new Error('A Codex adapter instance belongs to one root namespace'); namespace = context.namespace;
      const now = Date.parse(context.now); const diagnostics: Diagnostic[] = [];
      if (!lastProbe || now - lastProbe > 30_000) {
        lastProbe = now;
        try {
          const result = await context.command('codex',['app-server','daemon','version'],4000);
          if (result.code !== 0) { proxyReady = false; runtimeFailure = daemonFailureReason(result.stderr); proxy.close(); }
          else {
            const probe = parseDaemonProbe(result.stdout);
            await proxy.connect(context,probe.socket ?? undefined); proxyReady = true; runtimeFailure = '';
          }
        } catch { proxyReady = false; runtimeFailure = 'Existing Codex daemon observation is unavailable or returned an unsupported response. Persisted observation is active.'; proxy.close(); }
      }
      if(proxyReady&&!proxy.connected){proxyReady=false;liveThreads.clear();runtimeFailure='The existing Codex observer transport disconnected; current live thread status is unavailable.';}
      // Observe before enumeration, then reconcile loaded IDs again to close startup races.
      if (proxyReady && (!lastRuntime || now-lastRuntime >= 3000)) {
        lastRuntime = now;
        // Old notifications must not override a newer authoritative reconciliation read.
        proxy.notifications.clear();
        try {
          const first = await proxy.request('thread/loaded/list'); const ids = Array.isArray(first?.data) ? first.data.filter((x: unknown) => typeof x === 'string') as string[] : [];
          const next = new Map<string,any>();
          // State-db-only listing is optional. Never fall back to a repair scan.
          try { const list = await proxy.request('thread/list',{limit:100,useStateDbOnly:true,sortKey:'updated_at'}); if (Array.isArray(list?.data)) for (const thread of list.data) if (typeof thread?.id === 'string') next.set(thread.id,{...thread,__observerSequence:list.__observerSequence}); } catch { diagnostics.push(diagnostic(context,'codex-state-list-unsupported','State-database-only runtime listing is unsupported; native files supply history.')); }
          const second = await proxy.request('thread/loaded/list'); if (Array.isArray(second?.data)) for (const id of second.data) if (typeof id === 'string' && !ids.includes(id)) ids.push(id);
          for (let offset = 0; offset < Math.min(ids.length,512); offset += 8) await Promise.all(ids.slice(offset,offset+8).map(async id => { try { const read = await proxy.request('thread/read',{threadId:id,includeTurns:false}); if (read?.thread?.id === id) next.set(id,{...read.thread,__loaded:true,__observerSequence:read.__observerSequence}); } catch { diagnostics.push(diagnostic(context,'codex-thread-read-unavailable','A loaded thread could not be read; it will be reconciled again.')); } }));
          liveThreads = next;
          if (!lastAllowance || now-lastAllowance >= 30_000) {
            lastAllowance = now;
            try { const result = await proxy.request('account/rateLimits/read'); const entries = result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object' ? Object.values(result.rateLimitsByLimitId) : [result?.rateLimits]; liveAllowances = entries.flatMap(value => quotaFromSnapshot(value,context.namespace,'Codex account/rateLimits/read',context.now,context.now)); } catch { diagnostics.push(diagnostic(context,'codex-account-allowance-unavailable','The existing daemon does not expose a readable account allowance snapshot.')); }
          }
        } catch { proxyReady = false; proxy.close(); liveThreads.clear(); diagnostics.push(diagnostic(context,'codex-observer-disconnected','Existing daemon observer disconnected; file observation continues.','warning')); }
      }
      if (!lastScan || now-lastScan >= 10_000) {
        lastScan = now;
        const meta = await readMetadata(context);observerIds=new Set(meta.threads.filter(row=>isObserverWorkspace(row.cwd)).map(row=>row.id)); metadata = meta.threads.filter(row=>!observerIds.has(row.id)); metadataAvailable = meta.available;
        if (meta.errors) diagnostics.push(diagnostic(context,'codex-sqlite-partial','Some native metadata databases were locked or had unsupported schemas; they will be retried.'));
        const discovered = await Promise.all([discover(context,context.io.join(context.root,'sessions')),discover(context,context.io.join(context.root,'archived_sessions'))]);
        const byPath = new Map(discovered.flat().map(x => [x.path,x]));
        // Native metadata also discovers rollouts outside the dated directory layout.
        for (const thread of metadata) if (thread.rolloutPath && !byPath.has(thread.rolloutPath)) { const stat = await context.io.stat(thread.rolloutPath); if (stat) byPath.set(thread.rolloutPath,stat); }
        const metadataTimes=new Map(metadata.map(row=>[row.id,row.lastAt??'']));files = [...byPath.values()].filter(file=>!observerIds.has(file.path.match(UUID)?.[1]??'')).sort((a,b) => (metadataTimes.get(b.path.match(UUID)?.[1]??'')??'').localeCompare(metadataTimes.get(a.path.match(UUID)?.[1]??'')??'')||b.mtimeMs-a.mtimeMs);
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
          const currentInfo=await context.io.stat(file.path);if(!currentInfo)return;
          let header=headers.get(file.path);if(!header||header.identity!==currentInfo.identity){const record=await canonicalHeader(context,currentInfo,id);if(record){header={identity:currentInfo.identity,record};headers.set(file.path,header);}}
          const result = await context.ingest(file.path,() => initialCodexState(id),(state,record,meta)=>reduceCodex(state,record,{...meta,ingestedAt:context.now}));
          if (!result.state.canonical) return;
          if(result.state.observer){normalized.delete(id);states.delete(id);return;}
          let state=result.state;
          if(!result.complete&&header){let tail=tailCache.get(file.path);if(!tail||tail.identity!==currentInfo.identity||tail.size!==currentInfo.size||tail.mtimeMs!==currentInfo.mtimeMs||tail.generation!==result.generation){const observed=await readCodexTail(context,currentInfo,id,header.record);tail={identity:currentInfo.identity,size:currentInfo.size,mtimeMs:currentInfo.mtimeMs,generation:result.generation,state:observed};tailCache.set(file.path,tail);}state=mergeCodexObservations(result.state,tail.state);}else tailCache.delete(file.path);
          states.set(id,state); const session = sessionFromState(state,context.namespace,'Codex rollout',context.now);
          session.collection={lastCheckedAt:context.now,ingestedAt:result.bytesRead>0?context.now:normalized.get(id)?.collection?.ingestedAt??null,evidenceAt:state.lastAt,condition:result.complete?'current':'backfilling',reason:result.complete?'Native records reconciled':'Recent tail is observed; older source records are being backfilled'};
          if(!result.complete){if(session.task)session.task.coverage+=' Historical backfill is incomplete; recent tail evidence is included.';if(state.parent||state.fork||!state.modernTotal&&!state.legacyTotal){session.usage.provenance.quality=session.usage.value?'derived':'unavailable';session.usage.provenance.reason='Backfill is incomplete; consumption covers observed attributable responses only';}}
          session.archived = /(?:^|[\\/])archived_sessions[\\/]/.test(file.path); normalized.set(id,session);
          if (!result.complete) diagnostics.push(diagnostic(context,'codex-backfill','Session history is being backfilled progressively; available metrics may be partial.'));
          if (result.errors) diagnostics.push(diagnostic(context,'codex-json-record-skipped','Malformed persisted records were skipped; complete later records remain observable.','warning'));
        } catch { diagnostics.push(diagnostic(context,'codex-file-unavailable','A session source is temporarily unavailable or locked and will be retried.','warning')); }
      }));
      const sessions = new Map<string,Session>();
      for (const row of metadata) { const session = structuredClone(normalized.get(row.id) ?? emptySession('codex',context.namespace,row.id,'Codex native state database',context.now)); applyMetadata(session,row); sessions.set(row.id,session); }
      for (const [id,value] of normalized) if (!sessions.has(id)&&!observerIds.has(id)) sessions.set(id,structuredClone(value));
      const allowances = new Map<string,Allowance>();
      for (const [id,state] of states) { const session = sessions.get(id); if (!session || !state.quota) continue; const quota = quotaFromSnapshot(state.quota.value,context.namespace,'Codex persisted rate-limit snapshot',state.quota.at,context.now); session.allowanceIds = quota.map(x => x.id); for (const window of quota) { const previous = allowances.get(window.id); if (!previous || window.usedPercent.provenance.observedAt > previous.usedPercent.provenance.observedAt) allowances.set(window.id,window); } }
      for (const window of liveAllowances) { const refreshed = {...window,usedPercent:{...window.usedPercent,provenance:{...window.usedPercent.provenance}}}; if (now-Date.parse(window.usedPercent.provenance.observedAt)>300_000 || window.resetsAt && Date.parse(window.resetsAt)<=now) refreshed.usedPercent.provenance.quality='stale'; allowances.set(window.id,refreshed); }
      for (const [id,thread] of liveThreads) {
        if (!proxyReady) break;
        if(isObserverWorkspace(thread.cwd))continue;const session = sessions.get(id) ?? emptySession('codex',context.namespace,id,'Existing Codex app-server',context.now);
        applyRuntime(session,thread,context,thread.__loaded === true); sessions.set(id,session);
      }
      for (const session of sessions.values()) {
        if(!session.runtime.reachable)applyPersistedRuntimeReason(session,states.get(session.nativeId),context,runtimeFailure||'The existing daemon did not expose runtime status for this thread.',iso(lastProbe)??context.now);
        if (liveAllowances.length) session.allowanceIds = [...new Set([...session.allowanceIds,...liveAllowances.map(x => x.id)])];
        const title = Object.hasOwn(names,session.nativeId) ? names[session.nativeId] : undefined; if (title && session.nameSource !== 'native live name') { session.name = title.name; session.nameSource = 'native append-only naming index'; }
        const notification = proxy.notifications.get(`thread/name/updated:${session.nativeId}`); if (proxyReady && string(notification?.threadName ?? notification?.name)) { session.name = notification.threadName ?? notification.name; session.nameSource = 'native live name'; }
        const status = proxy.notifications.get(`thread/status/changed:${session.nativeId}`); if (proxyReady && status?.status&&newerRuntimeNotification(liveThreads.get(session.nativeId),status)) applyRuntime(session,{status:status.status},context,status.status.type !== 'notLoaded');
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
