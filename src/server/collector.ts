import { EventEmitter } from 'node:events';
import type { ProviderAdapter, SourceRoot } from '../shared/adapter.js';
import { metric, type Diagnostic, type Snapshot } from '../shared/types.js';
import { NativeIO, WslIO, command, processIdentity } from './io.js';
import { CacheStore } from './store.js';
import { discoverRoots, type MonitorConfig } from './discovery.js';
import { sanitize } from './privacy.js';
import type { ObserverSnapshot } from '../shared/observer.js';
import { isObserverSession } from './observer/service.js';
import { enrichSessions } from './enrichment.js';

interface RuntimeSource { root: SourceRoot; adapter: ProviderAdapter; io: NativeIO | WslIO }
export class Collector extends EventEmitter {
  private sources: RuntimeSource[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private refreshAt = 0;
  private sourceDiagnostics: Diagnostic[] = [];
  private pending?: Promise<void>;
  current: Snapshot;
  constructor(private store: CacheStore, private config: MonitorConfig, private factory: (root: SourceRoot) => ProviderAdapter) {
    super();
    this.current = store.snapshot() || { revision: 0, observedAt: new Date().toISOString(), sessions: [], allowances: [], diagnostics: [], collecting: true };
    this.current.collecting = true;
    for (const session of this.current.sessions) {
      session.runtime = { reachable: false, loaded: false, attachment: 'unknown', pid: null, processStartedAt: null, observedAt: null };
      session.state = metric('unknown', 'dashboard cache', 'runtime', 'stale', 'Rechecking runtime after dashboard restart');
    }
  }
  async start(): Promise<void> { this.stopped = false; await this.reconcile(); this.schedule(); }
  setObserver(observer: ObserverSnapshot): void { this.current = { ...this.current, revision: this.current.revision + 1, observer }; this.store.saveSnapshot(this.current); this.emit('snapshot', this.current); }
  private schedule(): void { if (!this.stopped) this.timer = setTimeout(() => { this.pending = this.reconcile().finally(() => this.schedule()); }, Math.max(750, this.config.pollMs || 2000)); }
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
    const activeRoots = new Set(this.sources.map(source => `${source.root.provider}:${source.root.namespace}`));
    for (const session of sessions.values()) if (!activeRoots.has(`${session.provider}:${session.namespace}`)) {
      session.runtime = { reachable: false, loaded: false, attachment: 'unknown', pid: null, processStartedAt: null, observedAt: session.runtime.observedAt };
      session.state = metric('unknown', 'source reconciliation', 'runtime', 'stale', 'Source is no longer reachable; last metrics are retained', now);
    }
    for (const source of this.sources) {
      try {
        const result = await source.adapter.poll({
          root: source.root.root, namespace: source.root.namespace, io: source.io, now,
          ingest: (file, initial, reduce) => this.store.ingest(source.root.namespace, source.io, file, initial, reduce),
          command: (exe, args, timeout) => command(exe, args, timeout, source.root),
          processIdentity: pid => processIdentity(pid, source.root)
        });
        const seen = new Set(result.sessions.map(s => s.id));
        for (const s of sessions.values()) if (s.provider === source.root.provider && s.namespace === source.root.namespace && !seen.has(s.id)) {
          s.runtime.reachable = false; s.runtime.loaded = false;
          s.state = metric('historical', 'source reconciliation', 'runtime', 'derived', 'No current runtime evidence');
        }
        for (const s of result.sessions) {
          if (isObserverSession(s)) { sessions.delete(s.id); continue; }
          const evidenceAt = s.lastActivityAt;
          s.collection ??= { lastCheckedAt: now, ingestedAt: null, evidenceAt, condition: 'current', reason: 'Native source checked; event timestamps remain source timestamps' };
          s.collection.lastCheckedAt = now;
          if (s.collection.condition === 'current' && evidenceAt && Date.now() - Date.parse(evidenceAt) > 5 * 60000) { s.collection.condition = 'stale'; s.collection.reason = 'Source is readable, but the latest native activity is older than five minutes'; }
          sessions.set(s.id, s);
        }
        for (const allowance of result.allowances) allowances.set(allowance.id, allowance);
        diagnostics.push(...result.diagnostics);
      } catch (error) {
        diagnostics.push({ provider: source.root.provider, namespace: source.root.namespace, code: 'source-read-failed', level: 'warning', message: 'A source is temporarily unavailable. Monitoring will retry; cached metrics are retained.', at: now });
        for (const s of sessions.values()) if (s.namespace === source.root.namespace && s.provider === source.root.provider) {
          s.runtime.reachable = false; s.runtime.loaded = false; s.state.provenance.quality = 'stale'; s.state.provenance.reason = 'Source unavailable; previous state retained';
          s.collection = { lastCheckedAt: now, ingestedAt: s.collection?.ingestedAt || null, evidenceAt: s.lastActivityAt, condition: 'unavailable', reason: 'Native source read failed; automatic retry will retain prior event times' };
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
    this.current = sanitize({ revision: this.current.revision + 1, observedAt: now, collecting: false, sessions: [...sessions.values()].sort((a, b) => Date.parse(b.lastActivityAt || '') - Date.parse(a.lastActivityAt || '') || a.id.localeCompare(b.id)), allowances: [...allowances.values()], diagnostics: conciseDiagnostics, observer: this.current.observer });
    this.store.saveSnapshot(this.current);
    this.emit('snapshot', this.current);
  }
  async close(): Promise<void> { this.stopped = true; clearTimeout(this.timer); await this.pending; await Promise.all(this.sources.map(x => x.adapter.close?.())); }
}
