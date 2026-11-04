import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObserverService, assembleObserverInput, validateSettings, isObserverSession } from '../src/server/observer/service.js';
import { CacheStore } from '../src/server/store.js';
import { emptySession, metric, type Session, type Snapshot } from '../src/shared/types.js';
import type { AssessmentContent, ObserverInput, ObserverWorker, WorkerResult } from '../src/shared/observer.js';

const now = Date.parse('2026-11-04T01:02:00Z');
const stores: CacheStore[] = []; const services: ObserverService[] = [];
function session(id = 'working'): Session {
  const s = emptySession('codex', 'fixture', id, 'native fixture', new Date(now).toISOString());
  s.state = metric('unknown', 'native rollout', 'runtime', 'derived', 'Recently active; runtime unconfirmed');
  s.lastActivityAt = new Date(now - 10000).toISOString(); s.startedAt = '2026-10-30T12:00:00Z';
  s.task = { id: `${id}:current-task`, revision: 1, objective: 'Implement observer scheduling and production build', startedAt: new Date(now - 120000).toISOString(), lastActivityAt: s.lastActivityAt, turnId: 'turn-current', state: 'active', instructionsRecovered: true, coverage: 'Current native request recovered', items: [{ id: `${id}:request`, kind: 'request', occurredAt: new Date(now - 120000).toISOString(), ingestedAt: new Date(now).toISOString(), source: 'native transcript', text: 'Implement observer scheduling, keep native sessions unchanged, run focused tests and a production build.' }] };
  return s;
}
function snapshot(sessions = [session()]): Snapshot { return { revision: 1, observedAt: new Date(now).toISOString(), sessions, allowances: [], diagnostics: [], collecting: false }; }
function content(input: ObserverInput, patch: Partial<AssessmentContent> = {}): AssessmentContent { return { taskSummary: input.task.objective, taskState: 'active', stage: 'Implementation and verification', remainingSteps: ['Finish scheduling', 'Run focused tests', 'Build production artifacts'], etaMinSeconds: 120, etaMaxSeconds: 420, confidence: 'low', basis: 'Initial assessment from recovered task and progress; no historical samples required. Parallel workers form a critical path.', blockers: [], supportingEvidenceIds: [input.evidence[0].id], ...patch }; }
function result(input: ObserverInput, patch: Partial<AssessmentContent> = {}): WorkerResult { return { content: content(input, patch), usage: { input: 100, cachedInput: 20, output: 30, cacheCreation: null, reasoning: 10, total: 130 }, model: 'gpt-6.1-sol', durationMs: 900 }; }
async function fixture(run = vi.fn(async (input: ObserverInput) => result(input))) {
  const store = new CacheStore(':memory:'); stores.push(store);
  const worker: ObserverWorker = { capabilities: async () => [{ provider: 'codex', available: true, version: 'fixture', models: ['gpt-6.1-sol'], efforts: ['medium', 'low'] }], run, close: async () => {} };
  const service = new ObserverService(store, worker); services.push(service); await service.start(); service.observe(snapshot());
  return { store, service, run, worker };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const store of stores.splice(0)) store.close(); vi.useRealTimers(); });
describe('backend-owned observer scheduling', () => {
  it('assesses an active current task immediately without conversation-age or training-sample gates', async () => {
    const { service, run, store } = await fixture(); service.select(session().id); await service.settled();
    expect(run).toHaveBeenCalledOnce(); expect(run.mock.calls[0][0].task.startedAt).not.toBe(session().startedAt);
    const assessment = service.snapshot.sessions[session().id].assessment!;
    expect(assessment.etaMinSeconds).toBe(120); expect(assessment.sessionId).toBe(session().id); expect(assessment.assessedAt).toBe(new Date(now).toISOString());
    expect(store.readState(`observer-assessment:${assessment.id}`)).toMatchObject({ taskId: session().task!.id, etaMaxSeconds: 420 });
  });
  it('duplicate clients/selects and repeated refresh clicks coalesce one slow worker', async () => {
    let finish!: (value: WorkerResult) => void;
    const run = vi.fn((input: ObserverInput) => new Promise<WorkerResult>(resolve => { finish = resolve; }));
    const { service } = await fixture(run); service.select(session().id); service.select(session().id); service.refresh(session().id); service.refresh(session().id);
    await vi.advanceTimersByTimeAsync(60000); expect(run).toHaveBeenCalledOnce(); expect(service.snapshot.sessions[session().id].inProgress).toBe(true);
    finish(result(run.mock.calls[0][0])); await service.settled(); expect(service.snapshot.sessions[session().id].inProgress).toBe(false);
    expect(Date.parse(service.snapshot.sessions[session().id].nextRefreshAt!)).toBe(Date.now() + 60000);
  });
  it('persists settings and completed assessment across backend restart', async () => {
    const { service, store, worker } = await fixture(); service.settings({ intervalSeconds: 120, timezone: 'America/New_York', model: 'gpt-6.1-sol' }); service.select(session().id); await service.settled();
    const restarted = new ObserverService(store, worker); services.push(restarted);
    expect(restarted.snapshot.settings).toMatchObject({ intervalSeconds: 120, timezone: 'America/New_York' });
    expect(restarted.snapshot.sessions[session().id].assessment?.taskId).toBe(session().task!.id); expect(restarted.snapshot.sessions[session().id].inProgress).toBe(false);
  });
  it('does not catch up missed interval bursts after sleep', async () => {
    const { service, run } = await fixture(); service.select(session().id); await service.settled();
    vi.setSystemTime(now + 5 * 60000); service.tick(); await service.settled(); service.tick(); await service.settled(); expect(run).toHaveBeenCalledTimes(2);
  });
  it('pauses automatic calls for completed/historical tasks and resumes only selected active work', async () => {
    const { service, run } = await fixture(); const done = session(); done.task!.state = 'complete'; done.state.value = 'historical'; service.observe(snapshot([done])); service.select(done.id); expect(run).not.toHaveBeenCalled();
    service.observe(snapshot()); await service.settled(); expect(run).toHaveBeenCalledOnce(); service.settings({ enabled: false }); await vi.advanceTimersByTimeAsync(600000); expect(run).toHaveBeenCalledOnce();
  });
  it('superseded task results cannot update a new task or a different selected session', async () => {
    let finish!: (value: WorkerResult) => void;
    const run = vi.fn((input: ObserverInput) => new Promise<WorkerResult>(resolve => { finish = resolve; }));
    const { service } = await fixture(run); service.select(session().id); const oldInput = run.mock.calls[0][0];
    const next = session(); next.task!.id = 'genuinely-new-task'; next.task!.revision = 1; service.observe(snapshot([next, session('other')])); service.settings({ enabled: false }); service.select(session('other').id);
    finish(result(oldInput)); await service.settled(); expect(service.snapshot.sessions[next.id].assessment).toBeNull(); expect(service.snapshot.sessions[session('other').id]?.assessment).toBeUndefined();
  });
  it('scope corrections invalidate in-flight evidence while ordinary progress keeps task identity', async () => {
    let finish!: (value: WorkerResult) => void;
    const run = vi.fn((input: ObserverInput) => new Promise<WorkerResult>(resolve => { finish = resolve; }));
    const { service } = await fixture(run); service.select(session().id); const input = run.mock.calls[0][0];
    const corrected = session(); corrected.task!.revision++; service.observe(snapshot([corrected])); service.settings({ enabled: false }); finish(result(input)); await service.settled();
    expect(service.snapshot.sessions[session().id].assessment).toBeNull();
  });
  it('retains previous assessment on specific authentication failure and backs off', async () => {
    const { service, run } = await fixture(); service.select(session().id); await service.settled(); const previous = service.snapshot.sessions[session().id].assessment;
    run.mockImplementationOnce(async () => { throw Object.assign(new Error('Claude authentication is required; sign in through the installed CLI.'), { code: 'authentication' }); });
    service.refresh(session().id); await service.settled(); const state = service.snapshot.sessions[session().id];
    expect(state.assessment?.id).toBe(previous?.id); expect(state.failure?.code).toBe('authentication'); expect(state.failure?.message).toContain('authentication'); expect(Date.parse(state.nextRefreshAt!)).toBe(now + 120000);
  });
  it.each(['timeout', 'invalid-output', 'provider-error'])('surfaces %s without fabricating a replacement estimate', async code => {
    const { service } = await fixture(vi.fn(async () => { throw Object.assign(new Error(`${code}: bounded worker failed`), { code }); })); service.select(session().id); await service.settled();
    expect(service.snapshot.sessions[session().id].failure?.code).toBe(code); expect(service.snapshot.sessions[session().id].assessment).toBeNull();
  });
  it('exposes broken current-request recovery rather than inventing task context', async () => {
    const { service, run } = await fixture(); const broken = session(); broken.task!.instructionsRecovered = false; service.observe(snapshot([broken])); service.select(broken.id); await service.settled();
    expect(run).not.toHaveBeenCalled(); expect(service.snapshot.sessions[broken.id].failure).toMatchObject({ code: 'evidence-unavailable', message: expect.stringContaining('native transcript') });
  });
  it('rejects malformed worker durations and unknown supporting evidence', async () => {
    const { service } = await fixture(vi.fn(async input => result(input, { etaMinSeconds: 900, etaMaxSeconds: 100, supportingEvidenceIds: ['invented-id'] })));
    service.select(session().id); await service.settled(); expect(service.snapshot.sessions[session().id].failure?.code).toBe('invalid-output');
  });
  it('stores observed task completion for later calibration', async () => {
    const { service, store } = await fixture(); service.select(session().id); await service.settled(); const complete = session(); complete.task!.state = 'complete'; complete.task!.lastActivityAt = new Date(now + 200000).toISOString(); service.observe(snapshot([complete]));
    expect(store.listState<{ actualRemainingSeconds: number }>('observer-completion:')[0].actualRemainingSeconds).toBe(200);
  });
  it('honors custom intervals longer than ten minutes without silently shortening them', async () => {
    const { service } = await fixture(); service.settings({ intervalSeconds: 3600 }); service.select(session().id); await service.settled();
    expect(Date.parse(service.snapshot.sessions[session().id].nextRefreshAt!)).toBe(now + 3600000);
  });
  it('provider/model changes trigger a new assessment while retaining the previous result during refresh', async () => {
    const { service, run } = await fixture(); service.select(session().id); await service.settled(); const previous = service.snapshot.sessions[session().id].assessment!;
    let finish!: (value: WorkerResult) => void; run.mockImplementationOnce(input => new Promise(resolve => { finish = resolve; }));
    service.settings({ model: 'gpt-6.1-sol', effort: 'low' }); expect(service.snapshot.sessions[session().id].assessment?.id).toBe(previous.id); expect(service.snapshot.sessions[session().id].inProgress).toBe(true);
    finish(result(run.mock.calls[1][0])); await service.settled(); expect(service.snapshot.sessions[session().id].assessment?.requestRevision).toBeGreaterThan(previous.requestRevision);
  });
  it('queues distinct manual requests behind the global limit and coalesces queued clicks', async () => {
    const waits: { input: ObserverInput; resolve: (value: WorkerResult) => void }[] = [];
    const run = vi.fn((input: ObserverInput) => new Promise<WorkerResult>(resolve => waits.push({ input, resolve })));
    const { service } = await fixture(run); service.settings({ enabled: false }); const a = session('a'), b = session('b'), c = session('c'); service.observe(snapshot([a, b, c]));
    service.refresh(a.id); service.refresh(b.id); service.refresh(c.id); service.refresh(c.id); expect(run).toHaveBeenCalledTimes(2); expect(service.snapshot.sessions[c.id].queued).toBe(true);
    waits[0].resolve(result(waits[0].input)); await Promise.resolve(); await Promise.resolve(); expect(run).toHaveBeenCalledTimes(3);
    waits[1].resolve(result(waits[1].input)); waits[2].resolve(result(waits[2].input)); await service.settled(); expect(service.snapshot.sessions[c.id].runs).toBe(1);
  });
  it.each([{ durationMs: NaN }, { durationMs: -1 }, { model: '\u0000hostile-model' }, { usage: { input: -1, output: 1, total: 0, cachedInput: 0, cacheCreation: null, reasoning: 0 } }])('rejects invalid worker metadata before persisting measured values: %j', async metadata => {
    const { service } = await fixture(vi.fn(async input => ({ ...result(input), ...metadata })));
    service.select(session().id); await service.settled(); expect(service.snapshot.sessions[session().id].failure?.code).toBe('invalid-output'); expect(service.snapshot.sessions[session().id].usage).toBeNull();
  });
});
it('bounds context while keeping instructions and blockers, and never infers context from conversation age', () => {
  const s = session(); s.task!.items.push({ id: 'blocker', kind: 'blocker', occurredAt: new Date(now - 50000).toISOString(), ingestedAt: new Date(now).toISOString(), source: 'native tool', text: 'Waiting for external build service' });
  for (let i = 0; i < 100; i++) s.task!.items.push({ id: `progress-${i}`, kind: 'progress', occurredAt: new Date(now - i * 100).toISOString(), ingestedAt: new Date(now).toISOString(), source: 'native assistant', text: 'Progress '.repeat(1000) });
  const input = assembleObserverInput(s, snapshot([s]), null); expect(input.evidence.map(e => e.id)).toContain('blocker'); expect(input.evidence.map(e => e.id)).toContain('working:request'); expect(input.evidence.reduce((sum, e) => sum + e.text.length, 0)).toBeLessThanOrEqual(32000);
});
it('excludes application-owned observer runs and validates persistent preferences', () => {
  const s = session(); s.cwd = 'C:\\Project\\.agent-monitor\\observer\\run-123'; expect(isObserverSession(s)).toBe(true);
  expect(() => validateSettings({ intervalSeconds: 1 })).toThrow('30'); expect(() => validateSettings({ timeoutSeconds: Infinity })).toThrow('timeout'); expect(() => validateSettings({ timezone: 'EST-blind-offset' })).toThrow('IANA'); expect(() => validateSettings({ shell: 'unsafe' })).toThrow('Unsupported');
});
