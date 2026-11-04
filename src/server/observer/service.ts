import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { defaultObserverSettings, type ObserverSettings, type ObserverSnapshot, type ObserverWorker, type ObserverInput, type ObserverSessionState, type ObserverAssessment, type ObserverFailure, type WorkerResult } from '../../shared/observer.js';
import { emptyUsage, type Session, type Snapshot, type Usage } from '../../shared/types.js';
import { CacheStore } from '../store.js';
import { sanitize, redact } from '../privacy.js';
import { validateAssessment } from './schema.js';
import { sessionEligibility } from '../../shared/lifecycle.js';
import { compareTimestamps,epochMilliseconds } from '../../shared/time.js';
import { logError } from '../errors.js';
import { ObserverWorkerError } from './process.js';

interface Persisted { settings: ObserverSettings; selectedSessionId: string | null; sessions: Record<string, ObserverSessionState>; revisions: Record<string, number> }
interface Running { taskId: string; taskRevision: number; requestRevision: number; abort: AbortController; promise: Promise<void> }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function measurementsJson(value:Record<string,unknown>):string {
  const full=JSON.stringify(value);if(full.length<=3800)return full;
  return JSON.stringify({...value,conversationHistory:undefined,coverage:'Lifetime timing details omitted to keep the current-task evidence packet bounded.'});
}
export function validateSettings(input: unknown, previous: ObserverSettings = defaultObserverSettings): ObserverSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object');
  const allowed = new Set(Object.keys(defaultObserverSettings));
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unsupported setting: ${key}`);
  const next = { ...previous, ...input };
  if (typeof next.enabled !== 'boolean') throw new Error('Automatic assessment must be on or off');
  if (!finite(next.intervalSeconds) || !Number.isInteger(next.intervalSeconds) || next.intervalSeconds < 30 || next.intervalSeconds > 86400) throw new Error('Refresh interval must be 30–86400 seconds');
  if (!finite(next.timeoutSeconds) || !Number.isInteger(next.timeoutSeconds) || next.timeoutSeconds < 10 || next.timeoutSeconds > 600) throw new Error('Worker timeout must be 10–600 seconds');
  if (!['codex', 'claude'].includes(next.provider)) throw new Error('Select Codex or Claude as observer');
  if (typeof next.model !== 'string' || next.model.length > 120 || !/^[\w.:-]*$/.test(next.model)) throw new Error('Invalid observer model');
  if (typeof next.effort !== 'string' || next.effort.length > 24 || !/^[a-z_\-]*$/.test(next.effort)) throw new Error('Invalid observer effort');
  if (next.timezone !== null) {
    if (typeof next.timezone !== 'string' || next.timezone.length > 100) throw new Error('Invalid timezone');
    try { new Intl.DateTimeFormat('en', { timeZone: next.timezone }); } catch { throw new Error('Timezone must be a valid IANA timezone'); }
  }
  return next;
}
function stateFor(sessionId: string): ObserverSessionState { return { sessionId, taskId: null, inProgress: false, requestedAt: null, nextRefreshAt: null, assessment: null, failure: null, usage: null, runs: 0 }; }
function addUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (!b) return a; if (!a) return b;
  const out = emptyUsage(); for (const key of Object.keys(out) as (keyof Usage)[]) out[key] = a[key] !== null && b[key] !== null ? a[key]! + b[key]! : null; return out;
}
function eligible(session: Session, now: number): boolean {
  return sessionEligibility(session,now).assessmentSuitable;
}
export function assembleObserverInput(session: Session, snapshot: Snapshot, previous: ObserverAssessment | null): ObserverInput {
  if (!session.task?.instructionsRecovered || !session.task.objective.trim()) throw new Error('Current task instructions have not been recovered from the native transcript. Collection will retry targeted history.');
  const task = structuredClone(session.task);
  // Instructions, scope corrections and unresolved blockers survive trimming. Recent progress
  // is selected by stable source IDs; duplicate content is never sent twice.
  const sorted = [...task.items].sort((a, b) => compareTimestamps(a.occurredAt,b.occurredAt) || a.id.localeCompare(b.id));
  const items = new Map<string, typeof sorted[number]>(); let budget = 44000;
  const select = (entries: typeof sorted, allocation: number) => {
    let remaining = Math.min(allocation, budget);
    for (const entry of entries) {
      if (items.has(entry.id) || remaining < 160 || budget < 160) continue;
      const text = redact(entry.text).slice(0, Math.min(4000, remaining - 80, budget - 80));
      items.set(entry.id, { ...entry, text }); budget -= text.length + 80; remaining -= text.length + 80;
    }
  };
  // Reserve separate space so old plans cannot push the newest scope correction or
  // unresolved dependency out of the packet.
  select(sorted.filter(e => e.kind === 'request'||e.status?.startsWith('user-input-continuation:')), 25200);
  select(sorted.filter(e => e.kind === 'blocker').reverse(), 3000);
  select(sorted.filter(e => e.kind === 'correction'&&!e.status?.startsWith('user-input-continuation:')).reverse(), 6500);
  select(sorted.filter(e => e.kind === 'plan').reverse(), 3500);
  const taskStart=epochMilliseconds(task.startedAt),children=snapshot.sessions.filter(s=>s.parentId===session.id&&!isObserverSession(s)&&((epochMilliseconds(s.lastActivityAt)??-Infinity)>=(taskStart??Infinity)||s.runtime.openTurn===true));
  const childEvidence=children.slice(0,12).flatMap(child=>(child.task?.items??[]).filter(item=>['progress','result','blocker','subagent'].includes(item.kind)).slice(-2).map(item=>({...item,id:`child:${child.nativeId}:${item.id}`,kind:'subagent' as const,text:`${child.agentRole??'implementation'} child ${child.nativeId}: ${redact(item.text).slice(0,650)}`})));
  select(childEvidence,4000);
  select(sorted.slice().reverse(), budget);
  const evidence = [...items.values()].sort((a, b) => compareTimestamps(a.occurredAt,b.occurredAt) || a.id.localeCompare(b.id));
  task.items = evidence;
  const childSummary = children.slice(0, 16).map(s => `${s.nativeId}: ${s.name}; ${s.agentRole??'implementation'}; ${s.state.value} (${s.state.provenance.quality}); ${s.latestActivity}; task ${s.task?.objective || 'not recovered'}`).join('\n').slice(0, 4000);
  return sanitize({ sessionId: session.id, nativeId: session.nativeId, provider: session.provider, sessionName: session.name,
    task, evidence, previousAssessment: previous?.taskId === task.id&&previous.taskRevision===task.revision ? previous : null,
    collectedAt: snapshot.observedAt, runtime: `${session.state.value} (${session.state.provenance.quality}; ${session.state.provenance.reason || session.state.provenance.source})`,
    collectionCondition: `${session.collection?.condition || 'unknown'}: ${session.collection?.reason || task.coverage}; checked ${session.collection?.lastCheckedAt || snapshot.observedAt}; event ${task.lastActivityAt}`,
    childSummary, measurements: measurementsJson({ currentTask: { checklist: session.timing.checklist, elapsedSeconds: taskStart===null?null:Math.max(0,(Date.now()-taskStart)/1000),timingBasis:'Elapsed wall time includes any pauses and is not a measurement of remaining time.' }, conversationHistory: { lastTurnMs: session.timing.lastTurnMs.value, averageTurnMs: session.timing.averageTurnMs.value, completedTurns: session.timing.completedTurns, toolStatistics: session.tools.slice(0,8).map(tool=>({name:tool.name.slice(0,80),calls:tool.calls,succeeded:tool.succeeded,failed:tool.failed,unknown:tool.unknown,durationMs:tool.durationMs,inFlight:tool.inFlight,interrupted:tool.interrupted})), scope: 'Lifetime conversation measurements; these are not remaining task work or current-task progress' }, calibration: null })
  });
}
export function isObserverSession(session: Session): boolean {
  return /(?:^|[\\/])\.agent-monitor[\\/]observer(?:[\\/]|$)/i.test(session.cwd || '') || /^Agent Monitor observer(?:\b|:)/i.test(session.name) || session.nativeId.startsWith('agent-monitor-observer:');
}
function validateWorkerMetadata(result: WorkerResult, settings: ObserverSettings): void {
  const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: 'invalid-output' }); };
  if (!Number.isFinite(result.durationMs) || result.durationMs < 0 || result.durationMs > settings.timeoutSeconds * 1000 + 15000) invalid('Observer returned an invalid measured execution duration.');
  if (typeof result.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(result.model)) invalid('Observer returned an invalid model identity.');
  if (result.delegation?.question !== 'How much remaining time' || typeof result.delegation.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(result.delegation.requestId)) invalid('No valid CLI subagent reply identity was returned.');
  if (result.usage !== null) {
    if (!result.usage || typeof result.usage !== 'object') invalid('Observer returned invalid usage metadata.');
    for (const field of Object.keys(emptyUsage()) as (keyof Usage)[]) { const value = result.usage[field]; if (value !== null && (!Number.isFinite(value) || typeof value !== 'number' || value < 0)) invalid(`Observer returned an invalid ${field} usage count.`); }
    if (settings.provider === 'codex' && result.usage.input !== null && result.usage.cachedInput !== null && result.usage.cachedInput > result.usage.input) invalid('Observer cached input exceeds reported input.');
    if (result.usage.output !== null && result.usage.reasoning !== null && result.usage.reasoning > result.usage.output) invalid('Observer reasoning usage exceeds reported output.');
  }
}

export class ObserverService extends EventEmitter {
  private data: Persisted;
  private capabilitiesValue: ObserverSnapshot['capabilities'] = [];
  private source: Snapshot = { revision: 0, observedAt: '', sessions: [], allowances: [], diagnostics: [], collecting: true };
  private running = new Map<string, Running>();
  private pending = new Map<string, { manual: boolean; taskId: string | null; taskRevision: number | null }>();
  private failures = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private capabilitiesPending:Promise<void>|null=null;
  private capabilitiesDueAt=0;
  private capabilityFailures=0;
  constructor(private store: CacheStore, private worker: ObserverWorker, private concurrency = 2) {
    super();
    this.data = store.readState<Persisted>('observer') || { settings: { ...defaultObserverSettings }, selectedSessionId: null, sessions: {}, revisions: {} };
    this.data.settings = validateSettings(this.data.settings);
    for (const state of Object.values(this.data.sessions)) { state.inProgress = false; state.queued = false; state.nextRefreshAt = null; }
  }
  get snapshot(): ObserverSnapshot { return structuredClone({ settings: this.data.settings, selectedSessionId: this.data.selectedSessionId, sessions: this.data.sessions, capabilities: this.capabilitiesValue }); }
  private publish(): void {
    try { this.store.writeState('observer', this.data); } catch (error) { logError('Observer settings/assessment persistence', error); }
    try { this.emit('change', this.snapshot); } catch (error) { logError('Observer update delivery', error); }
  }
  private refreshCapabilities():Promise<void> {
    if(this.closed)return Promise.resolve();if(this.capabilitiesPending)return this.capabilitiesPending;if(Date.now()<this.capabilitiesDueAt)return Promise.resolve();
    this.capabilitiesPending=(async()=>{try{const capabilities=await this.worker.capabilities();if(this.closed)return;this.capabilitiesValue=capabilities;this.capabilityFailures=capabilities.every(capability=>capability.available)?0:this.capabilityFailures+1;this.capabilitiesDueAt=Date.now()+(this.capabilityFailures?Math.min(60000,5000*2**Math.min(4,this.capabilityFailures-1)):5*60000);this.publish();}catch(error){if(this.closed)return;const cause=logError('Observer capability discovery',error);this.capabilityFailures++;this.capabilitiesDueAt=Date.now()+Math.min(60000,5000*2**Math.min(4,this.capabilityFailures-1));this.capabilitiesValue=(['codex','claude']as const).map(provider=>({provider,available:false,version:null,models:[],efforts:[],reason:`Capability discovery failed: ${cause}. Retrying with bounded backoff.`}));this.publish();}})().finally(()=>{this.capabilitiesPending=null;});return this.capabilitiesPending;
  }
  async start(): Promise<void> { await this.refreshCapabilities();if(this.closed)return;this.timer = setInterval(() => { try { this.tick(); } catch (error) { logError('Observer scheduler', error); } }, 1000); this.tick(); }
  observe(snapshot: Snapshot): void {
    this.source = snapshot;
    let changed = false;
    for (const session of snapshot.sessions) {
      const state = this.data.sessions[session.id]; if (!state || !session.task) continue;
      const running = this.running.get(session.id);
      if (running && (running.taskId !== session.task.id || running.taskRevision !== session.task.revision)) running.abort.abort();
      const lifecycle=sessionEligibility(session,Date.now());if(running&&['idle','complete','paused','historical'].includes(lifecycle.lifecycle))running.abort.abort();
      if (state.taskId !== session.task.id) {
        this.data.sessions[session.id] = { ...stateFor(session.id), taskId: session.task.id, taskRevision: session.task.revision, usage: state.usage, runs: state.runs };
        changed = true;
      } else if (state.taskRevision !== session.task.revision) {
        state.taskRevision = session.task.revision;
        state.failure = state.assessment ? { code: 'superseded', message: 'Task scope changed. The previous assessment predates the latest instructions; a fresh assessment is due.', at: new Date().toISOString(), provider: state.assessment.provider, source: 'task evidence revision' } : null;
        state.nextRefreshAt = new Date().toISOString(); changed = true;
      } else if (state.failure?.code === 'evidence-unavailable' && session.task.instructionsRecovered) {
        state.failure = null; state.nextRefreshAt = new Date().toISOString(); changed = true;
      }
      if (session.task.state === 'complete' && state.assessment?.taskId === session.task.id) {
        const key = `observer-completion:${session.id}:${session.task.id}`;
        if (!this.store.readState(key)) this.store.writeState(key, { sessionId: session.id, taskId: session.task.id, startedAt: session.task.startedAt, completedAt: session.task.lastActivityAt, lastAssessment: state.assessment, actualElapsedSeconds: Math.max(0, (Date.parse(session.task.lastActivityAt) - Date.parse(session.task.startedAt)) / 1000), actualRemainingSeconds: Math.max(0, (Date.parse(session.task.lastActivityAt) - Date.parse(state.assessment.assessedAt)) / 1000), provenance: 'Native reported task/turn completion, not independent verification' });
      }
      if (state.nextRefreshAt && !eligible(session, Date.now())) { state.nextRefreshAt = null; changed = true; }
      if(!this.running.has(session.id)&&!state.nextRefreshAt&&this.data.settings.enabled&&this.data.selectedSessionId===session.id&&eligible(session,Date.now())){const previousAt=epochMilliseconds(state.failure?.at??state.assessment?.assessedAt);const delay=state.failure?this.data.settings.intervalSeconds*2**Math.min(4,this.failures.get(session.id)||0):this.data.settings.intervalSeconds;state.nextRefreshAt=new Date(previousAt===null?Date.now():Math.max(Date.now(),previousAt+Math.min(86400,delay)*1000)).toISOString();changed=true;}
    }
    if (changed) this.publish();
    this.tick();
  }
  select(sessionId: string): ObserverSnapshot {
    const session = this.source.sessions.find(s => s.id === sessionId && !isObserverSession(s)); if (!session) throw new Error('Session is not currently available');
    if (sessionId !== this.data.selectedSessionId) {
      const previous = this.data.selectedSessionId && this.data.sessions[this.data.selectedSessionId]; if (previous) previous.nextRefreshAt = null;
      this.data.selectedSessionId = sessionId; this.publish();
    }
    this.tick(); return this.snapshot;
  }
  settings(patch: unknown): ObserverSnapshot {
    const next = validateSettings(patch, this.data.settings);
    const capabilities = this.capabilitiesValue.find(c => c.provider === next.provider);
    if (next.model && capabilities?.models.length && !capabilities.models.includes(next.model)) throw new Error('Model is not advertised by this observer provider');
    const efforts = capabilities?.modelEfforts?.[next.model || capabilities.defaultModel || ''] || capabilities?.efforts;
    if (next.effort && efforts?.length && !efforts.includes(next.effort)) throw new Error('Effort is not supported by this observer model');
    const identityChanged = next.provider !== this.data.settings.provider || next.model !== this.data.settings.model || next.effort !== this.data.settings.effort;
    this.data.settings = next;
    for (const [id, state] of Object.entries(this.data.sessions)) {
      if (identityChanged) { this.data.revisions[id] = (this.data.revisions[id] || 0) + 1; this.running.get(id)?.abort.abort(); }
      state.nextRefreshAt = null;
      if (next.enabled && identityChanged) state.nextRefreshAt = new Date().toISOString();
      if (next.enabled && !identityChanged && state.assessment) state.nextRefreshAt = new Date(Date.now() + next.intervalSeconds * 1000).toISOString();
    }
    this.publish(); this.tick(); return this.snapshot;
  }
  refresh(sessionId: string): ObserverSnapshot {
    const session = this.source.sessions.find(s => s.id === sessionId && !isObserverSession(s)); if (!session) throw new Error('Session is not currently available');
    this.launchAssessment(session, true); return this.snapshot;
  }
  tick(): void {
    if(!this.closed&&Date.now()>=this.capabilitiesDueAt)void this.refreshCapabilities().catch(error => { logError('Observer capability refresh', error); });
    if (this.closed || this.source.collecting || !this.data.settings.enabled || !this.data.selectedSessionId) return;
    const session = this.source.sessions.find(s => s.id === this.data.selectedSessionId);
    if (!session || !eligible(session, Date.now())) return;
    const state = this.data.sessions[session.id];
    if (!state || !state.assessment && !state.failure || state.nextRefreshAt && (epochMilliseconds(state.nextRefreshAt)??Infinity) <= Date.now()) this.launchAssessment(session);
  }
  private launchAssessment(session: Session, manual = false): void {
    void this.assess(session, manual).catch(error => {
      const message = logError('Observer assessment scheduling/persistence', error);
      const state = this.data.sessions[session.id] ||= stateFor(session.id);
      state.inProgress = false;
      state.failure = { code: 'provider-error', message, at: new Date().toISOString(), source: 'observer background operation' };
      state.nextRefreshAt = new Date(Date.now() + 60000).toISOString();
      this.publish();
    });
  }
  private async assess(session: Session, manual = false): Promise<void> {
    if (this.closed || this.running.has(session.id)) return;
    if (this.running.size >= this.concurrency) {
      const queued = this.pending.get(session.id);
      if(!queued&&this.pending.size>=32){const state=this.data.sessions[session.id]||=stateFor(session.id);state.queued=false;state.failure={code:'unavailable',message:'The observer queue is full. Retry after current assessments finish.',at:new Date().toISOString(),source:'bounded observer queue'};this.publish();return;}
      if (!queued || manual && !queued.manual) { this.pending.set(session.id, { manual, taskId: session.task?.id || null, taskRevision: session.task?.revision ?? null }); const state = this.data.sessions[session.id] ||= stateFor(session.id); state.queued = true; state.requestedAt = new Date().toISOString(); this.publish(); }
      return;
    }
    const state = this.data.sessions[session.id] ||= stateFor(session.id);
    let input: ObserverInput;
    try { input = assembleObserverInput(session, this.source, state.assessment); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Current task evidence unavailable';
      if (state.failure?.message !== message) { state.failure = { code: 'evidence-unavailable', message, at: new Date().toISOString(), source: 'native task evidence recovery' }; state.nextRefreshAt = new Date(Date.now() + 30000).toISOString(); this.publish(); }
      return;
    }
    const task = input.task;
    const calibration = this.store.listState<{ actualRemainingSeconds: number; lastAssessment: ObserverAssessment }>('observer-completion:', 30).filter(sample => sample.lastAssessment.provider === this.data.settings.provider && sample.lastAssessment.etaMaxSeconds !== null && sample.actualRemainingSeconds > 0);
    if (calibration.length){let measurements:Record<string,unknown>;try{measurements=JSON.parse(input.measurements);}catch{measurements={currentTask:{objective:task.objective}};}input.measurements=measurementsJson({...measurements,calibration:calibration.slice(0,4).map(sample=>({estimatedMinSeconds:sample.lastAssessment.etaMinSeconds,estimatedMaxSeconds:sample.lastAssessment.etaMaxSeconds,observedRemainingSeconds:sample.actualRemainingSeconds})),caveat:'Different reported tasks; weak calibration evidence, not a prerequisite for an initial estimate'});}
    const requestRevision = (this.data.revisions[session.id] || 0) + 1; this.data.revisions[session.id] = requestRevision;
    const abort = new AbortController();
    state.taskId = task.id; state.taskRevision = task.revision; state.inProgress = true; state.queued = false; state.requestedAt = new Date().toISOString(); state.nextRefreshAt = null;
    const settings = { ...this.data.settings };
    // Register before publishing so duplicate clients/clicks see the same job.
    const running: Running = { taskId: task.id, taskRevision: task.revision, requestRevision, abort, promise: Promise.resolve() };
    this.running.set(session.id, running); state.runs++; this.publish();
    running.promise = (async () => {
      try {
        const result = await this.worker.run(input, settings, abort.signal);
        validateWorkerMetadata(result, settings);
        const current = this.source.sessions.find(s => s.id === session.id)?.task;
        // Consumption belongs to the worker even when its assessment becomes superseded.
        const latestState = this.data.sessions[session.id]; latestState.usage = addUsage(latestState.usage, result.usage);
        if (abort.signal.aborted || current?.id !== task.id || current.revision !== task.revision || this.data.revisions[session.id] !== requestRevision) return;
        const content = validateAssessment(result.content, input.evidence.map(e => e.id));
        const assessment: ObserverAssessment = { ...content, id: randomUUID(), sessionId: session.id, taskId: task.id, taskRevision: task.revision, requestRevision,
          assessedAt: new Date().toISOString(), evidenceThrough: task.lastActivityAt, provider: settings.provider, model: result.model, durationMs: result.durationMs, usage: result.usage, delegation: result.delegation };
        state.assessment = sanitize(assessment); state.failure = null; this.failures.delete(session.id);
        this.store.writeState(`observer-assessment:${assessment.id}`, state.assessment);
      } catch (error) {
        // A rejected result can still carry reported provider consumption. Never
        // include it in the monitored conversation's totals or treat it as zero.
        if (error instanceof ObserverWorkerError && error.usage) {
          const latestState = this.data.sessions[session.id];
          latestState.usage = addUsage(latestState.usage, error.usage);
        }
        if (abort.signal.aborted) return;
        logError('Observer worker', error);
        const code = (error as { code?: string })?.code;
        const allowed: ObserverFailure['code'][] = ['authentication', 'timeout', 'invalid-output', 'provider-error', 'unavailable', 'evidence-unavailable'];
        state.failure = { code: allowed.includes(code as ObserverFailure['code']) ? code as ObserverFailure['code'] : 'provider-error', message: redact(error instanceof Error ? error.message : 'Observer failed').slice(0, 500), at: new Date().toISOString(), provider: settings.provider, source: 'isolated installed CLI execution' };
        this.failures.set(session.id, (this.failures.get(session.id) || 0) + 1);
      } finally {
        this.running.delete(session.id);
        const latestState = this.data.sessions[session.id]; latestState.inProgress = false;
        const current = this.source.sessions.find(s => s.id === session.id);
        const factor = 2 ** Math.min(4, this.failures.get(session.id) || 0);
        const superseded = current?.task?.id !== task.id || current.task.revision !== task.revision || this.data.revisions[session.id] !== requestRevision;
        latestState.nextRefreshAt = this.data.settings.enabled && this.data.selectedSessionId === session.id && current && eligible(current, Date.now()) ? new Date(Date.now() + (superseded ? 0 : Math.min(86400, this.data.settings.intervalSeconds * factor) * 1000)).toISOString() : null;
        this.publish();
        if (!this.closed) for (const [id, queued] of [...this.pending]) {
          if (this.running.size >= this.concurrency) break;
          this.pending.delete(id); const waiting = this.source.sessions.find(s => s.id === id);
          if (waiting?.task?.id === queued.taskId && waiting?.task?.revision === queued.taskRevision && (queued.manual || this.data.settings.enabled && this.data.selectedSessionId === id && eligible(waiting, Date.now()))) this.launchAssessment(waiting, queued.manual);
          else { const state = this.data.sessions[id]; if (state) { state.queued = false; state.nextRefreshAt = null; this.publish(); } }
        }
      }
    })();
    await running.promise;
  }
  async settled(): Promise<void> { while (this.running.size) await Promise.all([...this.running.values()].map(job => job.promise)); }
  async close(): Promise<void> { this.closed = true; this.pending.clear(); clearInterval(this.timer); for (const job of this.running.values()) job.abort.abort(); await this.worker.close();await this.capabilitiesPending; await this.settled(); }
}
