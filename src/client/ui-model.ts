import type { ObserverAssessment, ObserverCapabilities, ObserverSessionState, ObserverSettings, ObserverSnapshot } from '../shared/observer.js';
import type { Session } from '../shared/types.js';
import { compareTimestampsNewestFirst, epochMilliseconds, validTimeZone } from '../shared/time.js';
import { localFetch } from './http.js';
import { sessionEligibility } from '../shared/lifecycle.js';

export const assessmentIntervals = [30, 60, 120, 300, 600] as const;
export function availableObserverEfforts(capability: ObserverCapabilities | undefined, model: string): string[] {
  const resolvedModel = model.trim() || capability?.defaultModel;
  const modelEfforts = resolvedModel && capability?.modelEfforts && Object.hasOwn(capability.modelEfforts, resolvedModel) ? capability.modelEfforts[resolvedModel] : undefined;
  return [...new Set(modelEfforts ?? capability?.efforts ?? [])];
}
export function updateObserverDraft(current: ObserverSettings, patch: Partial<ObserverSettings>, capabilities: ObserverCapabilities[]): ObserverSettings {
  const next = { ...current, ...patch };
  if (patch.provider !== undefined && patch.provider !== current.provider && patch.model === undefined) next.model = '';
  if (patch.model !== undefined || patch.provider !== undefined) {
    const options = availableObserverEfforts(capabilities.find(value => value.provider === next.provider), next.model);
    if (!options.includes(next.effort)) next.effort = options.includes('medium') ? 'medium' : options[0] ?? '';
  }
  return next;
}
export function validateInterval(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(number) && number >= 30 && number <= 86400 ? number : null;
}
export function validateObserverForm(settings: Pick<ObserverSettings, 'timeoutSeconds' | 'timezone' | 'model' | 'effort'>): string | null {
  if (!Number.isInteger(settings.timeoutSeconds) || settings.timeoutSeconds < 10 || settings.timeoutSeconds > 600) return 'Timeout must be a whole number from 10 to 600 seconds.';
  if (settings.timezone !== null && !validTimeZone(settings.timezone)) return 'Enter a valid IANA timezone, such as America/New_York, or leave it empty for your browser timezone.';
  if (settings.model.length > 200 || settings.effort.length > 100) return 'Model and effort values are too long.';
  return null;
}
export function hasRecentActiveEvidence(session: Session, now: number): boolean {
  return sessionEligibility(session, now).defaultVisible;
}
export function defaultSessions(sessions: Session[], now: number): Session[] {
  return sessions.filter(session => sessionEligibility(session, now).defaultVisible).sort((a, b) => Number(sessionEligibility(b, now).runtimeConfirmed) - Number(sessionEligibility(a, now).runtimeConfirmed) || compareTimestampsNewestFirst(a.lastActivityAt, b.lastActivityAt));
}
export function defaultSelection(sessions: Session[], now: number): string | null {
  const eligible = defaultSessions(sessions, now);
  return eligible.find(session => sessionEligibility(session, now).runtimeConfirmed && session.state.value === 'running')?.id ?? eligible[0]?.id ?? null;
}
export function sessionTabs(sessions: Session[], selectedId: string | null, now: number): Session[] {
  const active = defaultSessions(sessions, now);
  const selected = sessions.find(session => session.id === selectedId && !session.parentId);
  return selected && !active.some(session => session.id === selected.id) ? [...active, selected] : active;
}
export interface SessionFilters { query: string; provider: 'all' | Session['provider']; showHistory: boolean }
export function filteredSessionCollection(sessions: Session[], filters: SessionFilters, now: number): Session[] {
  const query = filters.query.trim().toLowerCase();
  return sessions.filter(session => !session.parentId && (filters.showHistory || sessionEligibility(session, now).defaultVisible) && (filters.provider === 'all' || session.provider === filters.provider) && `${session.name} ${session.nativeId} ${session.cwd ?? ''} ${session.project ?? ''} ${session.model.value ?? ''}`.toLowerCase().includes(query)).sort((a, b) => Number(sessionEligibility(b, now).runtimeConfirmed) - Number(sessionEligibility(a, now).runtimeConfirmed) || compareTimestampsNewestFirst(a.lastActivityAt, b.lastActivityAt) || a.id.localeCompare(b.id));
}
export function initialAssessmentStatus(session: Session, state: ObserverSessionState | undefined, enabled: boolean): string {
  if (state?.inProgress) return 'Assessing current task';
  if (state?.queued) return 'Assessment queued';
  if (state?.failure) return 'Assessment failed';
  if (!enabled) return 'Automatic assessment off';
  if (!session.task?.instructionsRecovered) return 'Task instructions unavailable';
  if (session.task.state === 'complete') return 'Reported task complete';
  if (session.task.state === 'paused') return 'Task paused';
  const eligibility = sessionEligibility(session, Date.now());
  if (!eligibility.assessmentSuitable) return eligibility.assessmentReason;
  return 'Initial assessment pending';
}
export function currentTaskSpan(session: Session, now: number): { milliseconds: number | null; startedAt: string | null; basis: string } {
  const task = session.task;
  const started = epochMilliseconds(task?.startedAt);
  const basis = 'Wall-clock task span from native task timestamps; includes waits and gaps.';
  if (!task || started === null) return { milliseconds: null, startedAt: null, basis: 'Native task start time is unavailable.' };
  const end = task.state === 'active' ? now : epochMilliseconds(task.lastActivityAt);
  if (end === null || !Number.isFinite(end) || end < started) return { milliseconds: null, startedAt: task.startedAt, basis: 'Native task timestamps are unavailable or inconsistent; a task span cannot be calculated.' };
  return { milliseconds: end - started, startedAt: task.startedAt, basis: task.state === 'active' ? `${basis} Through the current time while the task is reported active.` : `${basis} Frozen at the last reported task activity while the task is ${task.state}.` };
}
export function assessmentRange(assessment: ObserverAssessment | null, now: number): { available: boolean; exceeded: boolean; minSeconds: number | null; maxSeconds: number | null; elapsedSeconds: number | null } {
  if (!assessment) return { available: false, exceeded: false, minSeconds: null, maxSeconds: null, elapsedSeconds: null };
  const at = epochMilliseconds(assessment.assessedAt);
  const elapsedSeconds = at === null ? null : Math.max(0, (now - at) / 1000);
  const min = assessment.etaMinSeconds, max = assessment.etaMaxSeconds;
  const available = typeof min === 'number' && Number.isFinite(min) && min >= 0 && typeof max === 'number' && Number.isFinite(max) && max >= min;
  return { available, exceeded: available && assessment.taskState === 'active' && elapsedSeconds !== null && elapsedSeconds > max!, minSeconds: available ? min : null, maxSeconds: available ? max : null, elapsedSeconds };
}
export async function observerRequest(endpoint: 'selection' | 'settings' | 'refresh', body: object): Promise<ObserverSnapshot> {
  const response = await localFetch(`/api/observer/${endpoint}`, { method: endpoint === 'settings' ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error(`Observer ${endpoint}: the local backend returned an unreadable response (${response.status}).`); }
  if (!response.ok) {
    const detail = data && typeof data === 'object' && 'error' in data ? String(data.error) : 'Request rejected';
    throw new Error(`Observer ${endpoint} (${response.status}): ${detail}`);
  }
  if (!data || typeof data !== 'object' || !('settings' in data) || !('sessions' in data)) throw new Error(`Observer ${endpoint}: the local backend returned an unsupported response.`);
  return data as ObserverSnapshot;
}
