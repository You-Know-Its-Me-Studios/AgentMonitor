import type { Session } from './types.js';
import { compareTimestampsNewestFirst, epochMilliseconds } from './time.js';

export interface SessionEligibility {
  defaultVisible: boolean;
  assessmentSuitable: boolean;
  defaultReason: string;
  assessmentReason: string;
  runtimeConfirmed: boolean;
  sourceHealthy: boolean;
  collectionCondition: 'current' | 'backfilling' | 'stale' | 'unavailable' | 'unknown';
  lifecycle: 'open' | 'idle' | 'complete' | 'paused' | 'historical' | 'unknown';
  activityAt: string | null;
}

/** Source checks, recorded task lifecycle, and confirmed runtime are independent. */
export function sessionEligibility(session: Session, now: number): SessionEligibility {
  // An open native turn does not expire because it has been quiet for some duration.
  void now;
  const collectionCondition = session.collection?.condition ?? 'unknown';
  const sourceHealthy = collectionCondition === 'current' || collectionCondition === 'backfilling';
  // Loaded membership can be freshly verified while transcript or task-status reads fail.
  const runtimeConfirmed = !session.archived && session.runtime.reachable && session.runtime.loaded && session.state.value !== 'historical';
  const occurrences = [session.collection?.evidenceAt, session.task?.lastActivityAt, ...session.activities.map(activity => activity.occurredAt ?? activity.at)];
  const activityAt = occurrences.filter((value): value is string => typeof value === 'string' && epochMilliseconds(value) !== null).sort(compareTimestampsNewestFirst)[0] ?? null;
  let lifecycle: SessionEligibility['lifecycle'];
  if (session.archived) lifecycle = 'historical';
  else if (session.runtime.openTurn === true) lifecycle = 'open';
  else if (session.task?.state === 'paused') lifecycle = 'paused';
  else if (session.task?.state === 'complete') lifecycle = 'complete';
  else if (session.runtime.openTurn === false) lifecycle = 'idle';
  else if (session.task?.state === 'active' || (runtimeConfirmed && ['running', 'approval', 'input'].includes(session.state.value ?? ''))) lifecycle = 'open';
  else if (runtimeConfirmed) lifecycle = 'idle';
  else lifecycle = session.state.value === 'historical' ? 'historical' : 'unknown';

  const topLevel = !session.parentId;
  const defaultVisible = topLevel && !session.archived && (runtimeConfirmed || lifecycle === 'open');
  const defaultReason = !topLevel ? 'Subagent is listed beneath its parent.' : session.archived ? 'Archived native history is available through the history toggle.' : runtimeConfirmed ? 'The native interface confirms a loaded runtime.' : lifecycle === 'open' ? session.runtime.openTurn === true ? 'A native turn is recorded open; runtime liveness remains unverified.' : 'Task evidence records an active task; runtime liveness remains unverified.' : session.runtime.openTurn === false ? 'The native turn is recorded closed; the conversation remains available in history.' : 'No loaded runtime or open task is currently recorded; the conversation remains available in history.';
  let assessmentReason: string;
  if (!topLevel) assessmentReason = 'Assess the parent task; subagent evidence is included separately.';
  else if (session.archived) assessmentReason = 'Archived conversations do not receive automatic assessments.';
  else if (session.task?.state === 'complete') assessmentReason = 'The recorded task is complete.';
  else if (session.task?.state === 'paused') assessmentReason = 'The recorded task is paused.';
  else if (lifecycle !== 'open') assessmentReason = session.runtime.openTurn === false ? 'The native turn is recorded closed.' : 'No open native turn or active task is recorded.';
  else if (!sourceHealthy) assessmentReason = session.collection?.reason || 'A successful source check has not yet been reported.';
  else if (!session.task?.instructionsRecovered) assessmentReason = session.task?.coverage || 'Current task instructions have not been recovered from the native source.';
  else assessmentReason = 'The recorded task is open, its instructions are recovered, and its native source is readable.';
  const assessmentSuitable = topLevel && !session.archived && lifecycle === 'open' && session.task?.state !== 'complete' && session.task?.state !== 'paused' && sourceHealthy && session.task?.instructionsRecovered === true;
  return { defaultVisible, assessmentSuitable, defaultReason, assessmentReason, runtimeConfirmed, sourceHealthy, collectionCondition, lifecycle, activityAt };
}
