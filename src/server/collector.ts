import { EventEmitter } from 'node:events';
import type { ProviderAdapter, SourceRoot } from '../shared/adapter.js';
import { metric, type CollectorStatus, type Diagnostic, type Snapshot } from '../shared/types.js';
import { NativeIO, WslIO, command, processIdentity } from './io.js';
import { CacheStore } from './store.js';
import { discoverRoots, type MonitorConfig } from './discovery.js';
import { sanitize } from './privacy.js';
import type { ObserverSnapshot } from '../shared/observer.js';
import { isObserverSession } from './observer/service.js';
import { enrichSessions } from './enrichment.js';
import { sessionEligibility } from '../shared/lifecycle.js';
import { logError } from './errors.js';

interface RuntimeSource { root: SourceRoot; adapter: ProviderAdapter; io: NativeIO | WslIO }
export class Collector extends EventEmitter {
  private sources: RuntimeSource[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private refreshAt = 0;
  private sourceDiagnostics: Diagnostic[] = [];
  private pending?: Promise<void>;
  current: Snapshot;
  status: CollectorStatus = { state: 'initializing', lastStartedAt: null, lastCompletedAt: null, lastError: null, cached: true };
  constructor(private store: CacheStore, private config: MonitorConfig, private factory: (root: SourceRoot) => ProviderAdapter) {
    super();
    this.current = store.snapshot() || { revision: 0, observedAt: new Date().toISOString(), sessions: [], allowances: [], diagnostics: [], collecting: true };
    this.current.collecting = true;
    for (const session of this.current.sessions) {
      session.runtime = { reachable: false, loaded: false, openTurn: session.runtime.openTurn, attachment: 'unknown', pid: null, processStartedAt: null, observedAt: null };
      session.state = metric('unknown', 'dashboard cache', 'runtime', 'stale', 'Rechecking runtime after dashboard restart');
      session.collection = { lastCheckedAt: session.collection?.lastCheckedAt || '', ingestedAt: session.collection?.ingestedAt || null, evidenceAt: sessionEligibility(session, Date.now()).activityAt, condition: 'unavailable', reason: 'Rechecking the native source after dashboard restart; recorded task lifecycle is retained' };
    }
  }
  async start(): Promise<void> { this.stopped = false; await this.safeReconcile(); this.schedule(); }
  private async safeReconcile(): Promise<void> {
    this.status.lastStartedAt = new Date().toISOString();
    try { await this.reconcile(); }
    catch (error) {
      const cause = logError('Collector reconciliation', error);
      const at = new Date().toISOString();
      this.status = { ...this.status, state: 'failed', lastError: cause, cached: true };
      this.current = { ...this.current, revision: this.current.revision + 1, collecting: false, diagnostics: [...this.current.diagnostics.filter(d => d.code !== 'collector-reconcile-failed'), { code: 'collector-reconcile-failed', level: 'error', message: `Collection failed: ${cause}. Existing observations are retained; collection will retry. See error.log for the stack.`, at }] };
      for (const session of this.current.sessions) {
        session.runtime.reachable = false; session.runtime.loaded = false; session.state.provenance.quality = 'stale';
        session.collection = { lastCheckedAt: at, ingestedAt: session.collection?.ingestedAt || null, evidenceAt: sessionEligibility(session, Date.parse(at)).activityAt, condition: 'unavailable', reason: 'Collection failed; the next bounded reconciliation will retry' };
      }
      this.emit('snapshot', this.current);
    }
  }
  setObserver(observer: ObserverSnapshot): void {
    this.current = { ...this.current, revision: this.current.revision + 1, observer };
    try { this.store.saveSnapshot(this.current); } catch (error) { logError('Observer snapshot persistence', error); }
    this.emit('snapshot', this.current);
  }
  private schedule(): void { if (!this.stopped) this.timer = setTimeout(() => { this.pending = this.safeReconcile().catch(error => { logError('Collector background notification', error); }).finally(() => this.schedule()); }, Math.max(750, this.config.pollMs || 2000)); }
  async reconcile(): Promise<void> {
    if (Date.now() >= this.refreshAt) {
      const discovery = await discoverRoots(this.config);
      this.sourceDiagnostics = discovery.diagnostics;
      const existing = new Map(this.sources.map(x => [`${x.root.provider}:${x.root.namespace}`, x]));
      const next: RuntimeSource[] = [];
      for (const root of discovery.roots) next.push(existing.get(`${root.provider}:${root.namespace}`) || { root, adapter: this.factory(root), io: root.distro ? new WslIO(root) : new NativeIO() });
      for (const source of this.sources) if (!next.includes(source)) await source.adapter.close?.();
      this.sources = next; this.refreshAt = Date.now() + 30000;
    }
    const now = new Date().toISOString();
    const sessions = new Map(this.current.sessions.map(s => [s.id, s]));
    const allowances = new Map(this.current.allowances.map(a => [a.id, a]));
    const diagnostics = [...this.sourceDiagnostics];
    let successfulSources = 0;
    const activeRoots = new Set(this.sources.map(source => `${source.root.provider}:${source.root.namespace}`));
    for (const session of sessions.values()) if (!activeRoots.has(`${session.provider}:${session.namespace}`)) {
      session.runtime = { reachable: false, loaded: false, openTurn: session.runtime.openTurn, attachment: 'unknown', pid: null, processStartedAt: null, observedAt: session.runtime.observedAt };
      session.state = metric('unknown', 'source reconciliation', 'runtime', 'stale', 'Source is no longer reachable; last metrics are retained', now);
      session.collection = { lastCheckedAt: now, ingestedAt: session.collection?.ingestedAt || null, evidenceAt: sessionEligibility(session, Date.parse(now)).activityAt, condition: 'unavailable', reason: 'Native source root is no longer reachable; the recorded turn lifecycle is retained' };
    }
    for (const source of this.sources) {
      try {
        const result = await source.adapter.poll({
          root: source.root.root, namespace: source.root.namespace, io: source.io, now,
          ingest: (file, initial, reduce) => this.store.ingest(source.root.namespace, source.io, file, initial, reduce),
          command: (exe, args, timeout) => command(exe, args, timeout, source.root),
          processIdentity: pid => processIdentity(pid, source.root)
        });
        successfulSources++;
        const seen = new Set(result.sessions.map(s => s.id));
        for (const s of sessions.values()) if (s.provider === source.root.provider && s.namespace === source.root.namespace && !seen.has(s.id)) {
          s.runtime.reachable = false; s.runtime.loaded = false;
          const recordedOpen = sessionEligibility(s, Date.parse(now)).lifecycle === 'open';
          s.state = metric(recordedOpen ? 'unknown' : 'historical', 'source reconciliation', 'runtime', 'stale', 'The session was not returned by the latest source reconciliation; prior lifecycle evidence is retained', now);
          s.collection = { lastCheckedAt: now, ingestedAt: s.collection?.ingestedAt || null, evidenceAt: sessionEligibility(s, Date.parse(now)).activityAt, condition: 'unavailable', reason: 'The latest native source reconciliation did not return this conversation; collection will retry' };
        }
        for (const s of result.sessions) {
          if (isObserverSession(s)) { sessions.delete(s.id); continue; }
          const evidenceAt = sessionEligibility(s, Date.parse(now)).activityAt;
          s.collection ??= { lastCheckedAt: now, ingestedAt: null, evidenceAt, condition: 'current', reason: 'Native source checked; event timestamps remain source timestamps' };
          s.collection.evidenceAt = evidenceAt;
          sessions.set(s.id, s);
        }
        for (const allowance of result.allowances) allowances.set(allowance.id, allowance);
        diagnostics.push(...result.diagnostics);
      } catch (error) {
        const cause = logError(`${source.root.provider} source collection`, error);
        diagnostics.push({ provider: source.root.provider, namespace: source.root.namespace, code: 'source-read-failed', level: 'warning', message: `Source read failed: ${cause}. Monitoring will retry; cached metrics are retained.`, at: now });
        for (const s of sessions.values()) if (s.namespace === source.root.namespace && s.provider === source.root.provider) {
          s.runtime.reachable = false; s.runtime.loaded = false; s.state.provenance.quality = 'stale'; s.state.provenance.reason = 'Source unavailable; previous state retained';
          s.collection = { lastCheckedAt: now, ingestedAt: s.collection?.ingestedAt || null, evidenceAt: sessionEligibility(s, Date.parse(now)).activityAt, condition: 'unavailable', reason: 'Native source read failed; automatic retry will retain prior event times' };
        }
      }
    }
    for (const s of [...sessions.values()]) if (isObserverSession(s)) sessions.delete(s.id);
    await enrichSessions([...sessions.values()], this.sources.map(s => s.root));
    for (const allowance of allowances.values()) {
      if (Date.now() - Date.parse(allowance.usedPercent.provenance.observedAt) > 5 * 60000 || (allowance.resetsAt && Date.parse(allowance.resetsAt) < Date.now())) {
        allowance.usedPercent.provenance.quality = 'stale'; allowance.usedPercent.provenance.reason = 'Snapshot expired; replenishment has not been observed';
      }
    }
    const distinct = new Map<string, { diagnostic: Diagnostic; count: number }>();
    for (const diagnostic of diagnostics) {
      const key = `${diagnostic.provider}:${diagnostic.namespace}:${diagnostic.level}:${diagnostic.code}:${diagnostic.message}`;
      const previous = distinct.get(key);
      if (previous) previous.count++; else distinct.set(key, { diagnostic, count: 1 });
    }
    const conciseDiagnostics = [...distinct.values()].map(({ diagnostic, count }) => count > 1 ? { ...diagnostic, message: `${diagnostic.message} (${count} sources)` } : diagnostic);
    this.current = sanitize({ revision: this.current.revision + 1, observedAt: now, collecting: false, sessions: [...sessions.values()].sort((a, b) => Date.parse(b.lastActivityAt || '') - Date.parse(a.lastActivityAt || '') || a.id.localeCompare(b.id)), allowances: [...allowances.values()], diagnostics: conciseDiagnostics, observer: this.current.observer, build: this.current.build });
    this.store.saveSnapshot(this.current);
    const degraded = this.current.sessions.some(session => session.collection?.condition === 'unavailable') || diagnostics.some(d => d.level === 'error' || d.level === 'warning');
    this.status = { ...this.status, state: degraded ? 'degraded' : 'ready', lastCompletedAt: new Date().toISOString(), lastError: diagnostics.find(d => d.level === 'error' || d.code === 'source-read-failed')?.message || null, cached: this.sources.length > 0 && successfulSources === 0 };
    this.emit('snapshot', this.current);
  }
  async close(): Promise<void> { this.stopped = true; clearTimeout(this.timer); await this.pending; await Promise.all(this.sources.map(x => x.adapter.close?.())); this.status.state = 'stopped'; }
}
