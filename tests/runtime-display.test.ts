import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecentActivity, SessionSummary, Status, SubagentRow } from '../src/client/App.js';
import { chronologicalActivities, runtimePresentation } from '../src/client/presentation.js';
import { emptySession, metric, type Activity, type Diagnostic } from '../src/shared/types.js';
import { formatTimestamp } from '../src/shared/time.js';

const now = Date.parse('2026-11-04T01:02:00Z');
const occurredAt = '2026-11-04T01:01:50Z';
function fileSession() {
  const s = emptySession('codex', 'native:test', 'session-a', 'native rollout', new Date(now).toISOString());
  s.state = metric('unknown', 'native runtime', 'runtime', 'derived', 'Existing daemon control socket denied (10013). Latest native turn is unfinished.');
  s.collection = { condition: 'current', reason: 'Incremental native records checked', lastCheckedAt: new Date(now).toISOString(), ingestedAt: new Date(now).toISOString(), evidenceAt: occurredAt };
  s.lastActivityAt = occurredAt;
  s.activities = [{ id: 'tool-a', kind: 'tool', label: 'Read source files', at: occurredAt, occurredAt, ingestedAt: new Date(now).toISOString() }];
  return s;
}
describe('source-aware runtime display', () => {
  it('presents recent native activity separately from unverified runtime and exposes the actual passive discovery failure', () => {
    const s = fileSession();
    expect(runtimePresentation(s, now)).toMatchObject({ label: 'Activity observed', verified: false });
    const status = renderToStaticMarkup(createElement(Status, { session: s, now }));
    expect(status).toContain('Activity observed'); expect(status).toContain('10s ago'); expect(status).not.toContain('>Unknown<'); expect(status).not.toContain('>Running<');
    const summary = renderToStaticMarkup(createElement(SessionSummary, { session: s, now }));
    expect(summary).toContain('Runtime unverified'); expect(summary).toContain('control socket denied (10013)'); expect(summary).toContain('native turn is unfinished');
    expect(summary).toContain('2026');
  });
  it('never treats collector checks, ingestion, or metadata freshness as proof of activity or liveness', () => {
    const s = fileSession(); s.activities = []; s.collection!.evidenceAt = null;
    s.lastActivityAt = new Date(now).toISOString(); s.runtime.loaded = true;
    expect(runtimePresentation(s, now)).toMatchObject({ label: 'Runtime unverified', verified: false, evidenceAt: null });
    expect(runtimePresentation(s, now).label).not.toBe('Running');
  });
  it('retains explicitly verified running and idle states while stale or unavailable collection remains distinct', () => {
    const s = fileSession(); s.runtime.reachable = true; s.runtime.loaded = true; s.state = metric('running', 'native status notification', 'runtime', 'reported');
    expect(runtimePresentation(s, now)).toMatchObject({ label: 'Running', verified: true });
    s.state = metric('idle', 'native status read', 'runtime', 'reported'); expect(runtimePresentation(s, now).label).toBe('Idle');
    s.collection!.condition = 'stale'; s.collection!.reason = 'Native source temporarily locked';
    expect(runtimePresentation(s, now)).toMatchObject({ label: 'Collection stale', verified: false });
    s.collection!.condition = 'unavailable'; expect(runtimePresentation(s, now).label).toBe('Collection unavailable');
  });
  it('distinguishes persisted historical sessions and current sources with no confirmed runtime', () => {
    const s = fileSession(); s.archived = true;
    expect(runtimePresentation(s, now).label).toBe('Historical session');
    s.archived = false; s.state = metric('historical', 'native persisted history', 'runtime', 'derived');
    expect(runtimePresentation(s, now + 3600000).label).toBe('Historical session');
    s.state = metric('unknown', 'native read unavailable', 'runtime', 'derived');
    expect(runtimePresentation(s, now + 3600000).label).toBe('Runtime unverified');
  });
  it('adds the matching native diagnostic without substituting account or other-provider errors', () => {
    const s = fileSession();
    const diagnostics: Diagnostic[] = [
      { provider: 'codex', namespace: s.namespace, level: 'warning', code: 'account-allowance-unavailable', message: 'Account allowance is unavailable', at: occurredAt },
      { provider: 'claude', level: 'warning', code: 'runtime-unavailable', message: 'Other provider failure', at: occurredAt },
      { provider: 'codex', namespace: s.namespace, level: 'warning', code: 'codex-proxy-unavailable', message: 'The existing passive proxy could not open its control socket', at: occurredAt },
    ];
    const view = runtimePresentation(s, now, diagnostics);
    expect(view.condition).toContain('passive proxy'); expect(view.condition).not.toContain('Account allowance'); expect(view.condition).not.toContain('Other provider');
  });
});
describe('visible subagent recency and one chronological timeline', () => {
  it('shows every subagent’s date/time, age, native runtime condition and role', () => {
    const s = fileSession(); s.agentRole = 'approval-reviewer';
    const html = renderToStaticMarkup(createElement(SubagentRow, { session: s, now }));
    expect(html).toContain('Approval reviewer'); expect(html).toContain('Runtime unverified'); expect(html).toContain('Collection current');
    expect(html).toContain('Last activity'); expect(html).toContain(formatTimestamp(occurredAt, undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    expect(html).toContain('10s ago'); expect(html).toContain('10013'); expect(html).toContain('2026');
  });
  it('explains missing activity timestamps without using a fresh collector check as the event time', () => {
    const s = fileSession(); s.lastActivityAt = null; s.activities = []; s.collection!.evidenceAt = null;
    const html = renderToStaticMarkup(createElement(SubagentRow, { session: s, now }));
    expect(html).toContain('No timestamp reported'); expect(html).toContain('The native source has no valid activity timestamp.');
    expect(html).not.toContain('<time'); expect(html).not.toContain('Just now');
  });
  it('orders normalized event instants newest first, resolves ties by ID, and ignores ingestion time for ordering', () => {
    const activities: Activity[] = [
      { id: 'old', kind: 'tool', label: 'Older event', at: occurredAt, ingestedAt: new Date(now + 3600000).toISOString() },
      { id: 'b', kind: 'tool', label: 'New B', at: '2026-11-04T01:02:00Z' },
      { id: 'a', kind: 'tool', label: 'New A', at: '2026-11-03T20:02:00-05:00' },
      { id: 'missing', kind: 'status', label: 'Unknown time', at: '2026-11-04 01:02:01', ingestedAt: new Date(now + 7200000).toISOString() },
    ];
    expect(chronologicalActivities(activities).map(a => a.id)).toEqual(['a', 'b', 'old', 'missing']);
    expect(activities.map(a => a.id)).toEqual(['old', 'b', 'a', 'missing']);
    const s = fileSession(); s.activities = activities;
    const html = renderToStaticMarkup(createElement(RecentActivity, { session: s, now }));
    expect(html).toContain('Activity timeline, newest first'); expect(html).toContain('Newest first');
    expect(html.indexOf('data-activity-id="a"')).toBeLessThan(html.indexOf('data-activity-id="b"'));
    expect(html.indexOf('data-activity-id="b"')).toBeLessThan(html.indexOf('data-activity-id="old"'));
    expect(html).toContain('No timestamp reported');
  });
});
