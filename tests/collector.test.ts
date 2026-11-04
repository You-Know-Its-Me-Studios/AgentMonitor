import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterResult, ProviderAdapter, SourceRoot } from '../src/shared/adapter.js';
import type { Allowance, Session } from '../src/shared/types.js';
import { emptySession, metric } from '../src/shared/types.js';
import { CacheStore } from '../src/server/store.js';
import { Collector } from '../src/server/collector.js';

const discovery = vi.hoisted(() => ({ roots: [] as SourceRoot[] }));
vi.mock('../src/server/discovery.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/server/discovery.js')>();
  return { ...actual, discoverRoots: vi.fn(async () => ({ roots: discovery.roots, diagnostics: [] })) };
});

const root: SourceRoot = { provider: 'codex', root: '/home/fixture/.codex', namespace: 'wsl:Fixture:fixture:/home/fixture/.codex', distro: 'Fixture', user: 'fixture' };
const baseTime = Date.parse('2026-11-03T18:00:00Z');
const stores: CacheStore[] = [];
const collectors: Collector[] = [];
function liveSession(): Session {
  const s = emptySession('codex', root.namespace, 'existing-conversation', 'fixture runtime');
  s.name = 'Existing conversation';
  s.runtime = { reachable: true, loaded: true, attachment: 'known', pid: 1234, processStartedAt: new Date(baseTime - 10000).toISOString(), observedAt: new Date(baseTime).toISOString() };
  s.state = metric('running', 'fixture runtime', 'runtime');
  s.usage = metric({ input: 120, output: 30, cachedInput: 20, cacheCreation: null, reasoning: 10, total: 150 }, 'fixture usage', 'session');
  return s;
}
function build(initial: AdapterResult) {
  const state = { result: initial, fail: false };
  const close = vi.fn(async () => {});
  const adapter: ProviderAdapter = { provider: 'codex', close, poll: vi.fn(async () => { if (state.fail) throw new Error('Fixture source temporarily locked'); return structuredClone(state.result); }) };
  const store = new CacheStore(':memory:'); stores.push(store);
  const collector = new Collector(store, { wsl: false }, () => adapter); collectors.push(collector);
  return { collector, store, state, close, adapter };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(baseTime); discovery.roots = [root]; });
afterEach(async () => { await Promise.all(collectors.splice(0).map(c => c.close())); for (const store of stores.splice(0)) store.close(); vi.useRealTimers(); });

describe('collector runtime evidence and stale account snapshots', () => {
  it('a stopped WSL source cannot retain reachable/running state from its last poll', async () => {
    const { collector, close } = build({ sessions: [liveSession()], allowances: [], diagnostics: [] });
    await collector.reconcile();
    expect(collector.current.sessions[0].runtime.reachable).toBe(true);
    discovery.roots = [];
    vi.setSystemTime(baseTime + 31000);
    await collector.reconcile();
    const cached = collector.current.sessions[0];
    expect(cached.runtime.reachable).toBe(false);
    expect(cached.runtime.loaded).toBe(false);
    expect(cached.runtime.attachment).toBe('unknown');
    expect(cached.runtime.pid).toBeNull();
    expect(cached.state.value).toBe('unknown');
    expect(cached.state.provenance.quality).toBe('stale');
    expect(cached.usage.value?.total).toBe(150);
    expect(close).toHaveBeenCalledOnce();
  });

  it('a temporary source failure clears current liveness while retaining metrics with a diagnostic', async () => {
    const { collector, state } = build({ sessions: [liveSession()], allowances: [], diagnostics: [] });
    await collector.reconcile();
    state.fail = true;
    vi.setSystemTime(baseTime + 2000);
    await collector.reconcile();
    const cached = collector.current.sessions[0];
    expect(cached.runtime.reachable).toBe(false);
    expect(cached.runtime.loaded).toBe(false);
    expect(cached.state.provenance.quality).toBe('stale');
    expect(cached.usage.value?.total).toBe(150);
    expect(collector.current.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'source-read-failed', level: 'warning' })]));
    state.fail = false;
    await collector.reconcile();
    expect(collector.current.sessions[0].runtime.reachable).toBe(true);
    expect(collector.current.sessions[0].state.provenance.quality).toBe('reported');
  });

  it('backend restart never presents cached runtime as freshly confirmed', async () => {
    const { collector, store, adapter } = build({ sessions: [liveSession()], allowances: [], diagnostics: [] });
    await collector.reconcile();
    const restarted = new Collector(store, { wsl: false }, () => adapter); collectors.push(restarted);
    const cached = restarted.current.sessions[0];
    expect(restarted.current.collecting).toBe(true);
    expect(cached.runtime).toMatchObject({ reachable: false, loaded: false, attachment: 'unknown', pid: null, processStartedAt: null, observedAt: null });
    expect(cached.state).toMatchObject({ value: 'unknown', provenance: { quality: 'stale' } });
    expect(cached.usage.value?.total).toBe(150);
    await restarted.reconcile();
    expect(restarted.current.sessions[0].runtime.reachable).toBe(true);
  });

  it('an old reset makes a quota stale without inventing replenishment', async () => {
    const allowance: Allowance = { id: 'account:primary', accountKey: 'account', label: 'Primary', usedPercent: metric(83, 'fixture account', 'account', 'reported', undefined, new Date(baseTime).toISOString()), windowMinutes: 300, resetsAt: new Date(baseTime + 60000).toISOString() };
    const { collector, state } = build({ sessions: [liveSession()], allowances: [allowance], diagnostics: [] });
    await collector.reconcile();
    expect(collector.current.allowances[0].usedPercent.provenance.quality).toBe('reported');
    state.result.allowances = [];
    vi.setSystemTime(baseTime + 61000);
    await collector.reconcile();
    const expired = collector.current.allowances[0];
    expect(expired.usedPercent.value).toBe(83);
    expect(expired.usedPercent.provenance.quality).toBe('stale');
    expect(expired.usedPercent.provenance.reason).toContain('replenishment has not been observed');
    expect(expired.resetsAt).toBe(allowance.resetsAt);
  });

  it('quota freshness expires even when the reported reset lies in the future', async () => {
    const allowance: Allowance = { id: 'account:weekly', accountKey: 'account', label: 'Weekly', usedPercent: metric(21, 'fixture account', 'account', 'reported', undefined, new Date(baseTime).toISOString()), windowMinutes: 10080, resetsAt: new Date(baseTime + 86400000).toISOString() };
    const { collector, state } = build({ sessions: [], allowances: [allowance], diagnostics: [] });
    await collector.reconcile();
    state.result.allowances = [];
    vi.setSystemTime(baseTime + 5 * 60000 + 1);
    await collector.reconcile();
    expect(collector.current.allowances[0].usedPercent).toMatchObject({ value: 21, provenance: { quality: 'stale' } });
  });
});
