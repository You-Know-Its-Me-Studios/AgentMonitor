import type { Activity, Diagnostic, Session } from '../shared/types.js';
import { compareTimestampsNewestFirst, epochMilliseconds, relativeAge } from '../shared/time.js';
import { sessionEligibility } from '../shared/lifecycle.js';

export function chronologicalActivities(activities: Activity[]): Activity[] {
  return activities.slice().sort((a, b) => compareTimestampsNewestFirst(a.occurredAt ?? a.at, b.occurredAt ?? b.at) || a.id.localeCompare(b.id));
}
export function attributedActivityAt(session: Session): string | null {
  return sessionEligibility(session, Date.now()).activityAt;
}
export function reportedActivityAt(session: Session): string | null {
  const candidates = [attributedActivityAt(session), session.lastActivityAt];
  return candidates.filter((value): value is string => typeof value === 'string' && epochMilliseconds(value) !== null).sort(compareTimestampsNewestFirst)[0] ?? null;
}
export function runtimePresentation(session: Session, now: number, diagnostics: Diagnostic[] = []) {
  const eligibility = sessionEligibility(session, now);
  const collection = eligibility.collectionCondition;
  const sourceFailure = [...session.diagnostics, ...diagnostics.filter(d => d.provider === session.provider && (!d.namespace || d.namespace === session.namespace))].find(d => d.level !== 'info' && !/account|quota|allowance|rate.limit/i.test(d.code) && /runtime|daemon|proxy|agents|process|registry|source|unavailable/i.test(d.code));
  const reasons = [collection === 'stale' || collection === 'unavailable' ? session.collection?.reason : null, session.state.provenance.reason, sourceFailure?.message].filter((value): value is string => Boolean(value));
  const condition = [...new Set(reasons)].join(' ') || session.collection?.reason || 'No supported runtime interface has confirmed the current process or task state.';
  const evidenceAt = eligibility.activityAt;
  const verified = eligibility.runtimeConfirmed;
  const openRecord = eligibility.lifecycle === 'open' ? 'The last recorded turn or task remains open. ' : '';
  if (session.archived) return { label: 'Historical session', tone: 'historical', verified: false, evidenceAt, condition, detail: `Archived native history. Runtime unverified. ${condition}` };
  if (session.agentError?.value) return { label: 'Agent error', tone: 'error', verified, evidenceAt: session.agentError.provenance.observedAt, condition, detail: `${session.agentError.value} ${condition}` };
  if (session.state.value === 'error' && session.state.provenance.quality === 'reported') return { label: 'Agent error', tone: 'error', verified, evidenceAt: session.state.provenance.observedAt, condition, detail: condition };
  const pendingQuestion = session.runtime.openTurn !== false && eligibility.lifecycle === 'open' && eligibility.sourceHealthy && session.tools.some(tool => /(?:^|[._/\s])(?:request_user_input(?:_async)?|AskUserQuestion)$/.test(tool.name) && ((tool.pending ?? 0) > 0 || (tool.inFlight ?? 0) > 0));
  if (pendingQuestion) return { label: 'Waiting for input', tone: 'input', verified, evidenceAt, condition, detail: `A native question tool is awaiting a result. ${condition}` };
  if (verified) {
    const names = { running: 'Running', idle: 'Idle', approval: 'Waiting for approval', input: 'Waiting for input', error: 'Agent error', complete: 'Task complete' };
    const state = session.state.value;
    const statusFresh = session.state.provenance.quality === 'reported';
    const label = statusFresh && state && state in names ? names[state as keyof typeof names] : 'Runtime loaded';
    return { label, tone: statusFresh && state && state in names ? state === 'complete' ? 'idle' : state : session.runtime.openTurn === true ? 'running' : 'idle', verified: true, evidenceAt, condition, detail: `Loaded runtime confirmed. ${!statusFresh ? 'Current task status is awaiting a readable native response. ' : ''}${condition}` };
  }
  if (collection === 'unavailable') return { label: 'Collection unavailable', tone: 'unavailable', verified: false, evidenceAt, condition, detail: `Runtime unverified. ${openRecord}${condition}` };
  if (collection === 'stale') return { label: 'Collection stale', tone: 'stale', verified: false, evidenceAt, condition, detail: `Runtime unverified. ${openRecord}${condition}` };
  if (eligibility.lifecycle === 'open') return { label: session.runtime.openTurn === true ? 'Recorded turn open' : 'Task recorded active', tone: 'running', verified: false, evidenceAt, condition, detail: `${eligibility.defaultReason} ${evidenceAt ? `Last source activity ${relativeAge(evidenceAt, now)}. ` : ''}${condition}` };
  if (eligibility.lifecycle === 'historical') return { label: 'Historical session', tone: 'historical', verified: false, evidenceAt, condition, detail: `Persisted native history. Runtime unverified. ${condition}` };
  if (session.runtime.openTurn === false) return { label: 'Recorded turn closed', tone: 'historical', verified: false, evidenceAt, condition, detail: `The last native turn is recorded closed. Runtime unverified. ${condition}` };
  if (eligibility.lifecycle === 'complete' || eligibility.lifecycle === 'paused') return { label: eligibility.lifecycle === 'complete' ? 'Recorded task complete' : 'Recorded task paused', tone: 'historical', verified: false, evidenceAt, condition, detail: `Recorded task lifecycle: ${eligibility.lifecycle}. Runtime unverified. ${condition}` };
  if (evidenceAt) return { label: 'Activity observed', tone: 'observed', verified: false, evidenceAt, condition, detail: `Source activity ${relativeAge(evidenceAt, now)}. Runtime unverified. ${condition}` };
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
