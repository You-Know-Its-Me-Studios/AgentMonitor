import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TimingPanel from '../src/client/TimingPanel.js';
import { SubagentsCard } from '../src/client/App.js';
import { assessmentRange, availableObserverEfforts, currentTaskSpan, defaultSelection, defaultSessions, observerRequest, sessionTabs, updateObserverDraft, validateInterval, validateObserverForm } from '../src/client/ui-model.js';
import { emptySession, metric } from '../src/shared/types.js';
import type { Session } from '../src/shared/types.js';
import { defaultObserverSettings } from '../src/shared/observer.js';
import type { ObserverAssessment, ObserverCapabilities, ObserverSnapshot, TaskEvidence } from '../src/shared/observer.js';

const now = Date.parse('2026-11-04T01:02:00Z');
function session(id = 'a'): Session {
  const result = emptySession('codex', 'test', id, 'test', new Date(now).toISOString());
  result.name = `Session ${id}`; result.cwd = 'C:\\same working directory'; result.lastActivityAt = new Date(now - 10000).toISOString();
  return result;
}
function assessment(): ObserverAssessment {
  return { id: 'assessment-1', sessionId: 'codex:test:a', taskId: 'task-1', taskRevision: 2, requestRevision: 1, assessedAt: '2026-11-04T01:01:50Z', evidenceThrough: '2026-11-04T01:01:40Z', provider: 'codex', model: 'gpt-6.1-sol', durationMs: 1200, usage: null, taskSummary: 'Finish the current source adapter', taskState: 'active', stage: 'Checking record coverage', remainingSteps: ['Review accounting', 'Run authorized unit tests'], etaMinSeconds: 120, etaMaxSeconds: 300, confidence: 'medium', basis: 'Two reported remaining steps and prior comparable durations.', blockers: ['One record shape is unavailable'], supportingEvidenceIds: ['evidence-1'] };
}
function observer(): ObserverSnapshot {
  return { settings: { ...defaultObserverSettings, model: 'gpt-6.1-sol', timezone: 'America/New_York' }, selectedSessionId: 'codex:test:a', sessions: { 'codex:test:a': { sessionId: 'codex:test:a', taskId: 'task-1', inProgress: false, requestedAt: null, nextRefreshAt: '2026-11-04T01:03:00Z', assessment: assessment(), failure: null, usage: { input: 100, output: 20, cachedInput: 0, cacheCreation: null, reasoning: 5, total: 120 }, runs: 1 } }, capabilities: [{ provider: 'codex', available: true, version: 'test', models: ['gpt-6.1-sol'], efforts: ['low', 'medium', 'high'] }] };
}
afterEach(() => vi.unstubAllGlobals());

describe('automatic navigation eligibility', () => {
  it('does not populate default tabs or selection with historical transcripts, even when timestamps are recent', () => {
    const historical = session();
    expect(defaultSessions([historical], now)).toEqual([]);
    expect(defaultSelection([historical], now)).toBeNull();
    expect(sessionTabs([historical], null, now)).toEqual([]);
    expect(sessionTabs([historical], historical.id, now)).toEqual([historical]);
  });
  it('shows separate same-directory live conversations and recent attributable task evidence', () => {
    const a = session('a'), b = session('b'), fileOnly = session('file');
    a.runtime.reachable = true; a.runtime.loaded = true; a.state = metric('idle', 'runtime', 'runtime');
    b.task = { id: 'task-b', revision: 1, objective: 'Implement adapter', startedAt: '2026-11-04T00:00:00Z', lastActivityAt: '2026-11-04T01:01:50Z', turnId: null, state: 'active', items: [], coverage: 'Attributable request and tool records', instructionsRecovered: true };
    b.collection = { lastCheckedAt: '2026-11-04T01:02:00Z', evidenceAt: b.task.lastActivityAt, ingestedAt: '2026-11-04T01:02:00Z', condition: 'current', reason: 'Current native task evidence' };
    const child = session('child'); child.parentId = a.id; child.runtime.reachable = true;
    expect(defaultSessions([a, b, fileOnly, child], now).map(value => value.id)).toEqual([a.id, b.id]);
    b.collection.condition = 'stale';
    expect(defaultSessions([a, b], now)).toEqual([a]);
  });
  it('adds new active tabs without discarding the explicitly selected history tab', () => {
    const historical = session('old'), later = session('new'); later.runtime.reachable = true;
    expect(sessionTabs([historical, later], historical.id, now).map(value => value.id)).toEqual([later.id, historical.id]);
    const renamed = { ...historical, name: 'Native rename' };
    expect(sessionTabs([renamed, later], historical.id, now).find(value => value.id === historical.id)?.name).toBe('Native rename');
  });
});

describe('observer controls and assessed remaining range', () => {
  it('shows known inclusive usage as an explicitly partial subtotal when a child contribution is unknown', () => {
    const parent = session(), child = session('child'); child.parentId = parent.id;
    const known = { input: 1000, output: 100, cachedInput: 200, cacheCreation: null, reasoning: null, total: 1100 };
    parent.usage = metric(known, 'native main agent', 'session');
    parent.aggregates = { main: known, children: null, inclusive: null, observedChildren: null, observedInclusive: known, childCount: 1, knownChildren: 0, partial: true };
    const html = renderToStaticMarkup(createElement(SubagentsCard, { session: parent, children: [child] }));
    expect(html).toContain('<span>Observed inclusive subtotal</span><strong>1,100</strong>');
    expect(html).toContain('0 of 1 child usage contributions reported.');
    expect(html).toContain('full inclusive usage remains unavailable');
    expect(parent.aggregates.inclusive).toBeNull();
    parent.aggregates.children = known; parent.aggregates.inclusive = { ...known, total: 2200 }; parent.aggregates.partial = false; parent.aggregates.knownChildren = 1;
    const complete = renderToStaticMarkup(createElement(SubagentsCard, { session: parent, children: [child] }));
    expect(complete).toContain('<span>Inclusive</span><strong>2,200</strong>'); expect(complete).not.toContain('Observed inclusive subtotal');
  });
  it('shows a two-minute current task separately from a multi-day recorded conversation span', () => {
    const current = session(); current.timing.elapsedMs = metric((3 * 24 + 9) * 3600000, 'native conversation timestamps', 'conversation', 'derived', 'Recorded conversation span includes resumed attachments and gaps');
    current.task = { id: 'task-1', revision: 2, objective: 'Implement the current task', startedAt: '2026-11-04T01:00:00Z', lastActivityAt: '2026-11-04T01:01:50Z', turnId: null, state: 'active', items: [], coverage: 'Current native request recovered', instructionsRecovered: true };
    const html = renderToStaticMarkup(createElement(TimingPanel, { session: current, observer: observer(), now, onObserver: () => {} }));
    expect(html).toContain('<span>Current task span</span><strong>2m 0s</strong>');
    expect(html).toContain('<dt>Recorded conversation span</dt>'); expect(html).toContain('3d 9h');
    expect(html).toContain('Wall-clock task span from native task timestamps; includes waits and gaps.');
    expect(html).toContain('<dt>Task started</dt>'); expect(html).toContain('Nov 3, 2026, 08:00:00 PM EST');
  });
  it('freezes paused and complete task spans at last activity and leaves inconsistent source dates unavailable', () => {
    const current = session(); current.task = { id: 'task-1', revision: 1, objective: 'Finish adapter', startedAt: '2026-11-04T00:59:00Z', lastActivityAt: '2026-11-04T01:01:00Z', turnId: null, state: 'complete', items: [], coverage: 'Native task timestamps', instructionsRecovered: true };
    expect(currentTaskSpan(current, now + 3600000)).toMatchObject({ milliseconds: 120000 });
    current.task.state = 'paused'; expect(currentTaskSpan(current, now + 7200000)).toMatchObject({ milliseconds: 120000 });
    current.task.lastActivityAt = '2026-11-04T00:58:00Z'; expect(currentTaskSpan(current, now).milliseconds).toBeNull();
    expect(currentTaskSpan(session(), now).milliseconds).toBeNull();
  });
  it('filters native effort choices by model, including the resolved provider default', () => {
    const capability: ObserverCapabilities = { provider: 'codex', available: true, version: 'test', models: ['gpt-6.1-sol', 'gpt-6-luna'], efforts: ['low', 'medium', 'high', 'ultra'], defaultModel: 'gpt-6-luna', modelEfforts: { 'gpt-6.1-sol': ['low', 'medium', 'high', 'ultra'], 'gpt-6-luna': ['low', 'medium', 'high'] } };
    expect(availableObserverEfforts(capability, 'gpt-6-luna')).toEqual(['low', 'medium', 'high']);
    expect(availableObserverEfforts(capability, '')).toEqual(['low', 'medium', 'high']);
    const value = observer(); value.settings.model = ''; value.capabilities = [capability];
    const html = renderToStaticMarkup(createElement(TimingPanel, { session: session(), observer: value, now, onObserver: () => {} }));
    const efforts = html.match(/aria-label="Observer effort"[^>]*>(.*?)<\/select>/s)?.[1];
    expect(efforts).toBeDefined(); expect(efforts).toContain('medium'); expect(efforts).not.toContain('ultra');
    expect(html).toContain('Provider default · gpt-6-luna');
  });
  it('preserves supported effort and resets invalid effort to medium, first, or empty when model/provider changes', () => {
    const codex: ObserverCapabilities = { provider: 'codex', available: true, version: 'test', models: ['sol', 'luna'], efforts: ['low', 'medium', 'high', 'ultra'], defaultModel: 'luna', modelEfforts: { sol: ['low', 'medium', 'high', 'ultra'], luna: ['low', 'medium', 'high'], minimal: ['low'], none: [] } };
    const claude: ObserverCapabilities = { provider: 'claude', available: true, version: 'test', models: ['sonnet'], efforts: ['low', 'high'], defaultModel: 'sonnet' };
    const current = { ...defaultObserverSettings, model: 'sol', effort: 'ultra' };
    expect(updateObserverDraft(current, { model: 'luna' }, [codex]).effort).toBe('medium');
    expect(updateObserverDraft({ ...current, effort: 'high' }, { model: 'luna' }, [codex]).effort).toBe('high');
    expect(updateObserverDraft(current, { model: '' }, [codex]).effort).toBe('medium');
    expect(updateObserverDraft(current, { model: 'minimal' }, [codex]).effort).toBe('low');
    expect(updateObserverDraft(current, { model: 'none' }, [codex]).effort).toBe('');
    expect(updateObserverDraft(current, { provider: 'claude' }, [codex, claude])).toMatchObject({ provider: 'claude', model: '', effort: 'low' });
    expect(availableObserverEfforts(claude, 'sonnet')).toEqual(['low', 'high']);
    expect(updateObserverDraft(current, { timeoutSeconds: 120 }, [codex]).effort).toBe('ultra');
  });
  it('renders enabled automatic assessment, the 60-second default, configured provider controls, last assessment and separate usage', () => {
    const html = renderToStaticMarkup(createElement(TimingPanel, { session: session(), observer: observer(), now, onObserver: () => {} }));
    expect(html).toContain('aria-label="Automatic AI assessment"'); expect(html).toContain('aria-checked="true"');
    expect(html).toContain('<option value="60" selected="">1 minute</option>');
    for (const name of ['Observer provider', 'Observer model', 'Observer effort', 'Observer timeout seconds', 'Display timezone']) expect(html).toContain(`aria-label="${name}"`);
    expect(html).toContain('Refresh now'); expect(html).toContain('Next assessment in 1m 0s');
    expect(html).toContain('Nov 3, 8:01:50 PM EST'); expect(html).toContain('Observer usage');
    expect(html).toContain('Separate from monitored-session usage'); expect(html).toContain('120 tokens');
    expect(html).toContain('Observed timing · separate from AI assessment');
  });
  it('retains the previous result while refreshing and shows a specific provider failure', () => {
    const value = observer(); value.sessions['codex:test:a'].inProgress = true;
    value.sessions['codex:test:a'].failure = { code: 'invalid-output', message: 'The Codex observer response did not match the assessment schema.', at: '2026-11-04T01:01:55Z', provider: 'codex', source: 'Installed Codex CLI response' };
    value.settings.provider = 'claude';
    const html = renderToStaticMarkup(createElement(TimingPanel, { session: session(), observer: value, now, onObserver: () => {} }));
    expect(html).toContain('Assessing…'); expect(html).toContain('The previous result remains visible');
    expect(html).toContain('Finish the current source adapter'); expect(html).toContain('Codex observer · invalid-output');
    expect(html).toContain('The Codex observer response did not match the assessment schema.');
  });
  it('marks an exceeded range while preserving its basis and original bounds', () => {
    const value = observer(); const at = now + 400000;
    expect(assessmentRange(assessment(), at)).toMatchObject({ available: true, exceeded: true, minSeconds: 120, maxSeconds: 300 });
    const html = renderToStaticMarkup(createElement(TimingPanel, { session: session(), observer: value, now: at, onObserver: () => {} }));
    expect(html).toContain('Last estimate exceeded'); expect(html).toContain('2m 0s – 5m 0s');
    expect(html).toContain('Two reported remaining steps'); expect(html).toContain('One record shape is unavailable');
  });
  it('keeps unsupported assessment values unavailable and ignores unknown ranges', () => {
    const value = observer(); value.sessions['codex:test:a'].assessment = null; value.settings.enabled = false;
    const html = renderToStaticMarkup(createElement(TimingPanel, { session: session(), observer: value, now, onObserver: () => {} }));
    expect(html).toContain('Automatic assessment is paused. Refresh now is still available');
    expect(html).toContain('Automatic assessment off'); expect(html).not.toContain('Not enough data yet'); expect(assessmentRange(null, now).available).toBe(false);
    expect(assessmentRange({ ...assessment(), etaMinSeconds: null, etaMaxSeconds: null }, now).available).toBe(false);
    expect(assessmentRange({ ...assessment(), taskState: 'complete', etaMinSeconds: 0, etaMaxSeconds: 0 }, now + 60000).exceeded).toBe(false);
  });
  it('reports the actual initial-assessment state and native evidence coverage instead of a generic dead end', () => {
    const current = session(); const task: TaskEvidence = { id: 'task-1', revision: 1, objective: 'Implement the source adapter', startedAt: '2026-11-04T01:00:00Z', lastActivityAt: '2026-11-04T01:01:50Z', turnId: null, state: 'active', items: [], coverage: 'Native rollout request and correction recovered', instructionsRecovered: true }; current.task = task;
    function rendered(change?: (value: ObserverSnapshot) => void) {
      const value = observer(); value.sessions['codex:test:a'].assessment = null; change?.(value);
      return renderToStaticMarkup(createElement(TimingPanel, { session: current, observer: value, now, onObserver: () => {} }));
    }
    expect(rendered()).toContain('Initial assessment pending');
    expect(rendered(value => { value.sessions['codex:test:a'].inProgress = true; })).toContain('Assessing current task');
    expect(rendered(value => { value.sessions['codex:test:a'].queued = true; })).toContain('Assessment queued');
    const failed = rendered(value => { value.sessions['codex:test:a'].failure = { code: 'authentication', provider: 'codex', source: 'Installed Codex CLI', message: 'The installed CLI could not authenticate.', at: '2026-11-04T01:01:59Z' }; });
    expect(failed).toContain('Assessment failed'); expect(failed).toContain('The installed CLI could not authenticate.');
    task.state = 'complete'; expect(rendered()).toContain('Reported task complete');
    task.state = 'paused'; expect(rendered()).toContain('Task paused');
    task.instructionsRecovered = false; task.coverage = 'Native history backfill has not reached the initial user request';
    const unavailable = rendered(); expect(unavailable).toContain('Task instructions unavailable'); expect(unavailable).toContain(task.coverage);
    expect(unavailable).not.toContain('Not enough data yet');
  });
  it('labels blocked ETA as conditional active work and excludes blocked wall time from exceeded ranges', () => {
    const value = observer(); value.sessions['codex:test:a'].assessment!.taskState = 'blocked';
    const later = now + 3600000;
    const html = renderToStaticMarkup(createElement(TimingPanel, { session: session(), observer: value, now: later, onObserver: () => {} }));
    expect(html).toContain('Active work after blocker clears');
    expect(html).toContain('Conditional work estimate. Time spent blocked is excluded.');
    expect(html).toContain('2m 0s – 5m 0s'); expect(html).not.toContain('Last estimate exceeded');
    expect(assessmentRange(value.sessions['codex:test:a'].assessment, later).exceeded).toBe(false);
  });
  it('shows a queued refresh while retaining the previous assessment', () => {
    const value = observer(); value.sessions['codex:test:a'].queued = true;
    const html = renderToStaticMarkup(createElement(TimingPanel, { session: session(), observer: value, now, onObserver: () => {} }));
    expect(html).toContain('Queued…'); expect(html).toContain('Assessment queued. The previous result remains visible.');
    expect(html).toContain('Finish the current source adapter');
  });
  it('labels previous evidence when corrections advance the current task revision', () => {
    const current = session(); current.task = { id: 'task-1', revision: 2, objective: 'Implement the adapter with the corrected scope', startedAt: '2026-11-04T01:00:00Z', lastActivityAt: '2026-11-04T01:01:59Z', turnId: null, state: 'active', items: [], coverage: 'Current native correction recovered', instructionsRecovered: true };
    const previous = observer(); previous.sessions['codex:test:a'].assessment!.taskRevision = 1;
    const html = renderToStaticMarkup(createElement(TimingPanel, { session: current, observer: previous, now, onObserver: () => {} }));
    expect(html).toContain('previous evidence'); expect(html).toContain('Task scope changed. The previous assessment covers revision 1; current evidence is revision 2');
    expect(html).toContain('Implement the adapter with the corrected scope');
  });
  it('validates custom scheduling, timeout and IANA timezone without accepting fractions or invalid values', () => {
    for (const value of [30, 60, 120, 300, 600, 86400, '90']) expect(validateInterval(value)).not.toBeNull();
    for (const value of [0, 29, 86401, 30.5, '30.5', '', NaN]) expect(validateInterval(value)).toBeNull();
    expect(validateObserverForm({ timeoutSeconds: 90, timezone: 'America/New_York', model: '', effort: 'medium' })).toBeNull();
    expect(validateObserverForm({ timeoutSeconds: 9, timezone: null, model: '', effort: 'medium' })).toContain('Timeout');
    expect(validateObserverForm({ timeoutSeconds: 90, timezone: 'not/a/timezone', model: '', effort: '' })).toContain('IANA');
  });
});

describe('observer API mutations', () => {
  it('uses transparent same-origin cookies and the correct methods and selection identity', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => observer() })); vi.stubGlobal('fetch', fetch);
    await observerRequest('selection', { sessionId: 'codex:test:a' });
    await observerRequest('settings', { enabled: false, intervalSeconds: 120 });
    await observerRequest('refresh', { sessionId: 'codex:test:a' });
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/observer/selection', '/api/observer/settings', '/api/observer/refresh']);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ sessionId: 'codex:test:a' }) });
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'PATCH', credentials: 'same-origin' });
  });
  it('surfaces request endpoint/status errors and rejects unsupported successful payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/' ? new Response('dashboard page') : { ok: false, status: 401, json: async () => ({ error: 'Local browser cookie expired' }) }));
    await expect(observerRequest('refresh', { sessionId: 'a' })).rejects.toThrow('Observer refresh (401): Local browser cookie expired');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) })));
    await expect(observerRequest('settings', { enabled: true })).rejects.toThrow('unsupported response');
  });
});
