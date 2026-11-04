import { useEffect, useState } from 'react';
import DetailDrawer from './DetailDrawer.js';
import type { ObserverSettings, ObserverSnapshot } from '../shared/observer.js';
import type { Session } from '../shared/types.js';
import { defaultObserverSettings } from '../shared/observer.js';
import { detectedTimeZone, epochMilliseconds, formatTimestamp, relativeAge } from '../shared/time.js';
import { assessmentIntervals, assessmentRange, availableObserverEfforts, currentTaskSpan, initialAssessmentStatus, observerRequest, updateObserverDraft, validateInterval, validateObserverForm } from './ui-model.js';

const providers = { codex: 'Codex', claude: 'Claude Code' };
const counts = new Intl.NumberFormat('en-US');
const count = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? counts.format(value) : '—';
function elapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m` : `${Math.floor(seconds / 86400)}d ${Math.floor(seconds / 3600) % 24}h`;
}
export interface TimingPanelProps { session: Session; observer?: ObserverSnapshot; now: number; onObserver: (value: ObserverSnapshot) => void; selectionError?: string | null }
export default function TimingPanel({ session, observer, now, onObserver, selectionError }: TimingPanelProps) {
  const [drawer, setDrawer] = useState<'assessment' | 'settings' | null>(null);
  const settings = observer?.settings ?? defaultObserverSettings;
  const state = observer?.sessions[session.id];
  const assessment = state?.assessment ?? null;
  const range = assessmentRange(assessment, now);
  const legacyEstimate = Boolean(assessment && !assessment.delegation);
  const [customInterval, setCustomInterval] = useState(String(settings.intervalSeconds));
  const [customMode, setCustomMode] = useState(!assessmentIntervals.some(value => value === settings.intervalSeconds));
  const [draft, setDraft] = useState(settings);
  const [dirty, setDirty] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const zone = settings.timezone;
  const capability = observer?.capabilities.find(value => value.provider === settings.provider);
  const draftCapability = observer?.capabilities.find(value => value.provider === draft.provider);
  const effortOptions = availableObserverEfforts(draftCapability, draft.model);
  const failureProvider = state?.failure?.provider ?? settings.provider;
  useEffect(() => { if (!dirty) setDraft(settings); }, [settings.provider, settings.model, settings.effort, settings.timeoutSeconds, settings.timezone, dirty]);
  useEffect(() => { setCustomInterval(String(settings.intervalSeconds)); setCustomMode(!assessmentIntervals.some(value => value === settings.intervalSeconds)); }, [settings.intervalSeconds]);
  useEffect(() => { setRequestError(null); setSaved(false); setDrawer(null); }, [session.id]);
  async function request(endpoint: 'settings' | 'refresh', body: object, commitDraft = false) {
    setPending(endpoint); setRequestError(null); setSaved(false);
    try { onObserver(await observerRequest(endpoint, body)); if (endpoint === 'settings') { if (commitDraft) setDirty(false); setSaved(true); } }
    catch { setRequestError(endpoint === 'settings' ? 'Settings could not be saved. Check the values and try Save ETA worker settings again.' : 'The estimate could not be requested. Try Refresh now again.'); }
    finally { setPending(null); }
  }
  const updateDraft = (patch: Partial<ObserverSettings>) => { setDraft(value => updateObserverDraft(value, patch, observer?.capabilities ?? [])); setDirty(true); setSaved(false); };
  const next = epochMilliseconds(state?.nextRefreshAt);
  const priorTask = Boolean(assessment && session.task && assessment.taskId !== session.task.id);
  const changedEvidence = Boolean(assessment && session.task && assessment.taskId === session.task.id && assessment.taskRevision !== session.task.revision);
  const latestEvidence = session.collection?.evidenceAt ?? session.task?.lastActivityAt ?? session.lastActivityAt;
  const condition = session.collection?.condition;
  const taskSpan = currentTaskSpan(session, now);
  const failureAt = epochMilliseconds(state?.failure?.at);
  const assessedAt = epochMilliseconds(assessment?.assessedAt);
  const currentFailure = !state?.inProgress && !state?.queued && state?.failure && (assessedAt === null || failureAt === null || failureAt > assessedAt) ? state.failure : null;
  const alternativeAvailable = observer?.capabilities.some(value => value.provider !== settings.provider && value.available);
  const userAction = currentFailure?.code === 'authentication'
    ? `Sign in to ${providers[failureProvider]} using its normal CLI, then select Refresh now.`
    : (currentFailure?.code === 'unavailable' || capability && !capability.available) && alternativeAvailable && !state?.inProgress && !state?.queued
      ? 'Choose an available provider under ETA worker settings to continue estimates.' : null;
  const assessmentStatus = state?.inProgress ? 'Updating estimate' : state?.queued ? 'Estimate queued'
    : userAction ? 'Action needed' : currentFailure || selectionError ? 'Estimate temporarily unavailable'
    : initialAssessmentStatus(session, state, settings.enabled);
  const scheduleMessage = state?.inProgress ? 'Updating estimate…'
    : state?.queued ? 'Update queued'
    : !settings.enabled ? 'Automatic estimates paused'
    : userAction ? 'Action needed · see worker settings'
    : !capability?.available || selectionError ? 'Estimate temporarily unavailable'
    : next === null && currentFailure ? 'Estimate temporarily unavailable'
    : next === null ? 'Waiting for an active task'
    : currentFailure ? `Retry ${next <= now ? 'due' : relativeAge(state?.nextRefreshAt, now)}`
    : next <= now ? 'Next update due' : `Next update ${relativeAge(state?.nextRefreshAt, now)}`;
  const taskState = session.task?.state === 'complete' ? 'complete' : session.task?.state === 'paused' ? 'paused' : !priorTask ? assessment?.taskState : undefined;
  const finished = taskState === 'complete' || taskState === 'idle' || taskState === 'paused';
  const showRange = range.available && !priorTask && !finished && !legacyEstimate;
  const estimateLabel = taskState === 'complete' ? 'Task complete' : taskState === 'idle' ? 'Idle' : taskState === 'paused' ? 'Paused'
    : showRange ? `${elapsed(range.minSeconds! * 1000)} – ${elapsed(range.maxSeconds! * 1000)}`
    : state?.inProgress ? 'Assessing…' : state?.queued ? 'Queued' : currentFailure || selectionError ? 'Unavailable' : 'Awaiting estimate';
  const brief = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, limit).replace(/\s+\S*$/, '')}…`;
  const stage = legacyEstimate ? finished ? `Task ${taskState}` : 'Awaiting a CLI subagent reply' : !priorTask && assessment ? assessment.stage : assessmentStatus;
  const blocker = !priorTask && !finished && !legacyEstimate ? assessment?.blockers[0] : null;
  const feedback = <>{requestError && <p className="observer-error" role="alert">{requestError}</p>}{saved && <p className="observer-saved" role="status">Settings saved.</p>}{userAction && <p className="observer-error" role="alert">{userAction}</p>}</>;
  return <>
    <div className="eta-overview" aria-label="Current task estimate">
      <span className="metric-label">{taskState === 'blocked' ? 'Work remaining after blocker' : 'Estimated remaining'}</span>
      <strong className={`eta-value${showRange ? '' : ' eta-condition'}`}>{estimateLabel}</strong>
      <div className="eta-confidence"><span>{!priorTask && assessment && !legacyEstimate ? `${assessment.confidence} confidence` : 'No current subagent reply'}</span>{assessment && !priorTask && !legacyEstimate && <time dateTime={assessment.assessedAt} title={formatTimestamp(assessment.assessedAt, zone)}>Assessed {relativeAge(assessment.assessedAt, now)}</time>}</div>
      {(priorTask || changedEvidence || (range.exceeded && showRange)) && <p className="eta-notice">{priorTask ? 'New task · previous estimate in details' : changedEvidence ? 'Scope changed · estimate awaiting update' : 'Estimate exceeded · reassessment needed'}</p>}
      <div className="task-elapsed" title={taskSpan.basis}><span>Current task elapsed</span><strong>{elapsed(taskSpan.milliseconds)}</strong></div>
      <p className="eta-stage"><span>Stage</span>{brief(stage, 105)}</p>
      {blocker && <p className="eta-blocker"><strong>Blocker</strong> {brief(blocker, 125)}</p>}
    </div>
    <div className="observer-controls" aria-label="AI assessment controls"><div className="observer-control-heading"><span>Automatic</span><button type="button" role="switch" aria-checked={settings.enabled} aria-label="Automatic ETA estimates" className={`observer-switch${settings.enabled ? ' enabled' : ''}`} disabled={!observer || pending !== null} onClick={() => void request('settings', { enabled: !settings.enabled })}><span />{settings.enabled ? 'On' : 'Off'}</button></div><div className="observer-interval-row"><label>Interval<select aria-label="Wait between ETA estimates" disabled={!observer || pending !== null} value={customMode ? 'custom' : String(settings.intervalSeconds)} onChange={event => { if (event.target.value === 'custom') setCustomMode(true); else { setCustomMode(false); void request('settings', { intervalSeconds: Number(event.target.value) }); } }}>{assessmentIntervals.map(value => <option value={value} key={value}>{value < 60 ? `${value} seconds` : `${value / 60} minute${value === 60 ? '' : 's'}`}</option>)}<option value="custom">Custom</option></select></label><button type="button" className="refresh-now" disabled={!observer || pending !== null || state?.inProgress || state?.queued || !capability?.available} onClick={() => void request('refresh', { sessionId: session.id })}>{state?.inProgress || pending === 'refresh' ? 'Assessing…' : state?.queued ? 'Queued…' : 'Refresh now'}</button></div>{customMode && <form className="custom-interval" onSubmit={event => { event.preventDefault(); const interval = validateInterval(customInterval); if (interval === null) { setRequestError('Assessment interval must be a whole number from 30 to 86,400 seconds.'); return; } void request('settings', { intervalSeconds: interval }); }}><label>Custom seconds<input type="number" min="30" max="86400" step="1" value={customInterval} onChange={event => setCustomInterval(event.target.value)} aria-label="Custom assessment interval seconds" /></label><button type="submit" className="text-button" disabled={!observer || pending !== null}>Apply</button></form>}<p className="observer-schedule" title={`Intervals start after each assessment finishes. Refresh now requests an AI estimate. ${formatTimestamp(state?.nextRefreshAt, zone)}`}>{scheduleMessage}</p>{!observer && <p className="observer-schedule">Preparing ETA estimates…</p>}</div>
    {!drawer && feedback}
    <div className="card-detail-actions"><button type="button" className="detail-link" onClick={() => setDrawer('assessment')}>Assessment details</button><button type="button" className="detail-link" onClick={() => setDrawer('settings')}>Worker settings</button></div>
    {drawer && <DetailDrawer title={drawer === 'settings' ? 'ETA worker settings' : 'Task assessment'} onClose={() => setDrawer(null)}>
      {feedback}
      {drawer === 'settings' ? <>
    <p className="observer-explanation">The configured CLI agent asks an ETA subagent “How much remaining time” using this session’s recorded progress. The subagent’s returned estimate is shown here. The controls below configure that worker and leave your working CLI session unchanged.</p>
    <p className="observer-session"><strong>Monitored session · automatically detected</strong><span>{providers[session.provider]} · {session.model.value ?? 'Model not reported'}{session.effort.value ? ` · ${session.effort.value} effort` : ''}{session.model.provenance.quality === 'stale' || session.effort.provenance.quality === 'stale' ? ' · last reported' : ''}</span></p>
    <section className="observer-settings"><h3>ETA worker settings</h3><p className="observer-explanation">Use these optional settings to choose which AI produces the estimates, even if your monitored session uses another provider or model. These assessments use the selected provider’s account.</p><form onSubmit={event => { event.preventDefault(); const error = validateObserverForm(draft); if (error) { setRequestError(error); return; } void request('settings', { provider: draft.provider, model: draft.model.trim(), effort: draft.effort.trim(), timeoutSeconds: draft.timeoutSeconds, timezone: draft.timezone?.trim() || null }, true); }}><label>ETA provider<select value={draft.provider} onChange={event => updateDraft({ provider: event.target.value as ObserverSettings['provider'] })} aria-label="ETA worker provider" disabled={pending !== null || !observer}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label><label>ETA model<select aria-label="ETA worker model" disabled={pending !== null || !observer} value={draft.model} onChange={event => updateDraft({ model: event.target.value })}><option value="">Default ETA model{draftCapability?.defaultModel ? ` · ${draftCapability.defaultModel}` : ""}</option>{draft.model && !draftCapability?.models.includes(draft.model) && <option value={draft.model} disabled>{draft.model} · unavailable</option>}{draftCapability?.models.map(value => <option value={value} key={value}>{value}</option>)}</select></label><label>ETA reasoning effort<select aria-label="ETA worker reasoning effort" disabled={pending !== null || !observer || effortOptions.length === 0} value={effortOptions.includes(draft.effort) ? draft.effort : ""} onChange={event => updateDraft({ effort: event.target.value })}><option value="" disabled>{effortOptions.length ? "Choose a supported effort" : "No reported effort options"}</option>{effortOptions.map(value => <option value={value} key={value}>{value}</option>)}</select>{draft.effort && !effortOptions.includes(draft.effort) && <small className="text-amber">Saved effort is unsupported for this model. Choose an available effort.</small>}</label><label>ETA timeout (seconds)<input aria-label="ETA worker timeout seconds" disabled={pending !== null || !observer} type="number" min="10" max="600" step="1" value={Number.isNaN(draft.timeoutSeconds) ? '' : draft.timeoutSeconds} onChange={event => updateDraft({ timeoutSeconds: event.target.value === '' ? NaN : Number(event.target.value) })} /></label><label className="observer-zone">Display timezone<input aria-label="Display timezone" disabled={pending !== null || !observer} placeholder={`Browser · ${detectedTimeZone()}`} value={draft.timezone ?? ''} maxLength={100} onChange={event => updateDraft({ timezone: event.target.value || null })} /></label><p className="observer-settings-note">Maximum duration per assessment: {draft.timeoutSeconds || "—"} seconds. Leave display timezone blank to use your browser’s timezone. Installed ETA CLI: {draftCapability ? `${providers[draft.provider]} ${draftCapability.version ?? ''}${draftCapability.available ? ' · ready' : ' · unavailable'}` : 'Capability detection pending'}. Times use {settings.timezone || detectedTimeZone()}.</p><button type="submit" className="refresh-now" disabled={!observer || pending !== null || !dirty}>Save ETA worker settings</button></form></section>
      </> : <>
    <div className="ai-assessment" aria-label="AI task assessment"><div className="assessment-heading"><span>{legacyEstimate ? 'Previous assessment' : 'CLI subagent reply'}</span><span className={`assessment-state assessment-${assessment?.taskState ?? 'unknown'}`}>{assessment?.taskState ?? assessmentStatus}{priorTask || changedEvidence ? ' · previous evidence' : ''}</span></div>{assessment ? <>{(priorTask || changedEvidence) && session.task && <div className="current-task-evidence"><strong>Current task from native evidence</strong><p>{session.task.objective}</p></div>}<p className="assessment-summary">{assessment.taskSummary}</p>{legacyEstimate && <p className="observer-source-unavailable">Stored estimate from the previous assessment method. A new CLI subagent reply will replace it.</p>}{priorTask && <p className="observer-source-unavailable">Previous task assessment. Current task evidence is awaiting reassessment.</p>}{changedEvidence && <p className="observer-source-unavailable">Task scope changed. The previous assessment covers revision {assessment.taskRevision}; current evidence is revision {session.task?.revision}.</p>}<dl className="assessment-details"><div><dt>Stage</dt><dd>{assessment.stage}</dd></div><div><dt>{assessment.taskState === "blocked" ? "Active work after blocker clears" : "Remaining at assessment"}</dt><dd>{range.available ? `${elapsed(range.minSeconds! * 1000)} – ${elapsed(range.maxSeconds! * 1000)}` : 'No supported range reported'}</dd></div><div><dt>Confidence</dt><dd>{assessment.confidence}</dd></div></dl>{assessment.taskState === "blocked" && range.available && <p className="assessment-basis">Conditional work estimate. Time spent blocked is excluded.</p>}{range.exceeded && <p className="estimate-exceeded">Last estimate exceeded. The assessed range remains above; refresh to reassess remaining work.</p>}<p className="assessment-basis"><strong>Basis</strong>{assessment.basis}</p>{assessment.remainingSteps.length > 0 && <div className="assessment-list"><strong>Remaining work</strong><ul>{assessment.remainingSteps.map((value, index) => <li key={index}>{value}</li>)}</ul></div>}{assessment.blockers.length > 0 && <div className="assessment-list assessment-blockers"><strong>Blockers and dependencies</strong><ul>{assessment.blockers.map((value, index) => <li key={index}>{value}</li>)}</ul></div>}<p className="assessment-at">{assessment.delegation && <>Question: {assessment.delegation.question}<br />CLI delegation: {assessment.delegation.requestId}<br /></>}Last assessed {formatTimestamp(assessment.assessedAt, zone)}<br />Evidence through {formatTimestamp(assessment.evidenceThrough, zone)}<br />{providers[assessment.provider]} · {assessment.model} · {elapsed(assessment.durationMs)}</p></> : <><p className="assessment-summary">{session.task?.objective ?? 'Current task instructions are not yet recoverable from the source.'}</p><p className="assessment-basis">An ETA will appear after an assessment of this task’s progress completes.</p><strong className="assessment-unavailable" role="status">{assessmentStatus}</strong><p className="assessment-at">Last assessed: not yet<br />Evidence through {formatTimestamp(latestEvidence, zone)}</p></>}<div className="observer-usage"><span>Reported CLI usage</span><strong>{count(state?.usage?.total)} tokens</strong><small>{count(state?.runs)} assessments · input {count(state?.usage?.input)} · output {count(state?.usage?.output)}<br />Usage reported by the separate CLI run; excluded from monitored-session totals. Child usage may not be separately reported.</small></div></div>
    <div className="runtime-timing"><span className="runtime-section-label">Observed timing · separate from AI assessment</span><div className="elapsed-metric" title={taskSpan.basis}><span>Current task span</span><strong>{elapsed(taskSpan.milliseconds)}</strong></div><dl className="timing-details"><div><dt>Task started</dt><dd><time dateTime={taskSpan.startedAt ?? undefined} title={formatTimestamp(taskSpan.startedAt, zone, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}>{formatTimestamp(taskSpan.startedAt, zone, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></dd></div><div><dt>Recorded conversation span</dt><dd title={session.timing.elapsedMs.provenance.reason ?? "Recorded conversation wall-clock span; includes waits and gaps."}>{elapsed(session.timing.elapsedMs.value)}</dd></div><div><dt>Last event</dt><dd title={formatTimestamp(latestEvidence, zone)}>{relativeAge(latestEvidence, now)}</dd></div><div><dt>Source checked</dt><dd title={formatTimestamp(session.collection?.lastCheckedAt, zone)}>{relativeAge(session.collection?.lastCheckedAt, now)}</dd></div><div><dt>Collection</dt><dd title={session.collection?.reason}>{condition ?? 'Not reported'}</dd></div><div><dt>Completed turns</dt><dd>{count(session.timing.completedTurns)}</dd></div><div><dt>Last turn</dt><dd>{elapsed(session.timing.lastTurnMs.value)}</dd></div><div><dt>Average turn</dt><dd>{elapsed(session.timing.averageTurnMs.value)}</dd></div></dl>{session.timing.checklist && <div className="checklist"><div className="bar-track"><span className="green" style={{ width: session.timing.checklist.total ? `${Math.min(100, session.timing.checklist.completed / session.timing.checklist.total * 100)}%` : '0%' }} /></div><small>{session.timing.checklist.completed} of {session.timing.checklist.total} reported steps complete</small></div>}</div>
      </>}
    </DetailDrawer>}
  </>;
}
