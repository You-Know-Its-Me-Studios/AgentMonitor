import type { Activity, Diagnostic, Session } from '../shared/types.js';
import { compareTimestampsNewestFirst, epochMilliseconds, relativeAge } from '../shared/time.js';

export function chronologicalActivities(activities: Activity[]): Activity[] {
  return activities.slice().sort((a, b) => compareTimestampsNewestFirst(a.occurredAt ?? a.at, b.occurredAt ?? b.at) || a.id.localeCompare(b.id));
}
export function attributedActivityAt(session: Session): string | null {
  const candidates = [session.collection?.evidenceAt, session.task?.lastActivityAt, ...session.activities.map(a => a.occurredAt ?? a.at)];
  return candidates.filter((value): value is string => typeof value === 'string' && epochMilliseconds(value) !== null).sort(compareTimestampsNewestFirst)[0] ?? null;
}
export function reportedActivityAt(session: Session): string | null {
  const candidates = [attributedActivityAt(session), session.lastActivityAt];
  return candidates.filter((value): value is string => typeof value === 'string' && epochMilliseconds(value) !== null).sort(compareTimestampsNewestFirst)[0] ?? null;
}
export function runtimePresentation(session: Session, now: number, diagnostics: Diagnostic[] = []) {
  const collection = session.collection?.condition;
  const sourceFailure = [...session.diagnostics, ...diagnostics.filter(d => d.provider === session.provider && (!d.namespace || d.namespace === session.namespace))].find(d => d.level !== 'info' && !/account|quota|allowance|rate.limit/i.test(d.code) && /runtime|daemon|proxy|agents|process|registry|source|unavailable/i.test(d.code));
  const reasons = [collection === 'stale' || collection === 'unavailable' ? session.collection?.reason : null, session.state.provenance.reason, sourceFailure?.message].filter((value): value is string => Boolean(value));
  const condition = [...new Set(reasons)].join(' ') || session.collection?.reason || 'No supported runtime interface has confirmed the current process or task state.';
  const evidenceAt = attributedActivityAt(session);
  const evidence = epochMilliseconds(evidenceAt);
  const verified = session.runtime.reachable && session.state.provenance.quality !== 'stale' && collection !== 'stale' && collection !== 'unavailable';
  if (collection === 'unavailable') return { label: 'Collection unavailable', tone: 'unavailable', verified: false, evidenceAt, condition, detail: `Runtime unverified. ${condition}` };
  if (collection === 'stale' || session.state.provenance.quality === 'stale') return { label: 'Collection stale', tone: 'stale', verified: false, evidenceAt, condition, detail: `Runtime unverified. ${condition}` };
  if (verified) {
    const names = { running: 'Running', idle: 'Idle', approval: 'Waiting for approval', input: 'Waiting for input', complete: 'Task complete' };
    const state = session.state.value;
    const label = state && state in names ? names[state as keyof typeof names] : 'Runtime reachable';
    return { label, tone: state ?? 'idle', verified: true, evidenceAt, condition: sourceFailure?.message ?? 'Confirmed by the native runtime interface.', detail: `Runtime confirmed. ${sourceFailure?.message ?? 'The native runtime interface is reachable.'}` };
  }
  if (session.archived) return { label: 'Historical session', tone: 'historical', verified: false, evidenceAt, condition, detail: `Archived native history. Runtime unverified. ${condition}` };
  if (evidence !== null && evidence <= now + 60000 && now - evidence <= 30 * 60000) return { label: 'Activity observed', tone: 'observed', verified: false, evidenceAt, condition, detail: `Source activity ${relativeAge(evidenceAt, now)}. Runtime unverified. ${condition}` };
  if (session.state.value === 'historical') return { label: 'Historical session', tone: 'historical', verified: false, evidenceAt, condition, detail: `Persisted native history. Runtime unverified. ${condition}` };
  return { label: 'Runtime unverified', tone: 'unknown', verified: false, evidenceAt, condition, detail: condition };
}
export function limitSessionTabs(sessions: Session[], selectedId: string | null, limit: number): Session[] {
  const count = Math.max(1, Math.floor(limit));
  const visible = sessions.slice(0, count);
  const selected = sessions.find(session => session.id === selectedId);
  if (selected && !visible.some(session => session.id === selected.id)) visible[visible.length ? visible.length - 1 : 0] = selected;
  return visible;
}
export function nextTabIndex(key: string, index: number, count: number): number | null {
  if (count < 1) return null;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
