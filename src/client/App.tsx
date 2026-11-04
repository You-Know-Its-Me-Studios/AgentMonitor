import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Allowance, Diagnostic, Metric, Session, Snapshot, Usage } from '../shared/types.js';
import type { ObserverSnapshot } from '../shared/observer.js';
import { compareTimestamps, epochMilliseconds, formatTimestamp, relativeAge } from '../shared/time.js';
import TimingPanel from './TimingPanel.js';
import { defaultSelection, defaultSessions, hasRecentActiveEvidence, observerRequest, sessionTabs } from './ui-model.js';

const SELECTION_KEY = 'agent-monitor.selected-session';
const n = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const providerNames = { codex: 'Codex', claude: 'Claude Code' };
const stateNames = { running: 'Running', idle: 'Idle', approval: 'Waiting for approval', input: 'Waiting for input', complete: 'Task complete', historical: 'Historical', unknown: 'Unknown' };
const emptySnapshot: Snapshot = { revision: 0, observedAt: '', sessions: [], allowances: [], diagnostics: [], collecting: true };
const isKnown = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
const fmt = (value: number | null | undefined) => isKnown(value) ? n.format(value) : '—';
const short = (value: number | null | undefined) => isKnown(value) ? compact.format(value) : '—';
const DisplayZone = createContext<string | null>(null);
function useTimes() {
  const zone = useContext(DisplayZone);
  const when = (value: unknown, options?: Intl.DateTimeFormatOptions) => formatTimestamp(value, zone, options);
  const provenance = <T,>(value: Metric<T>): string => {
    const p = value.provenance;
    return `${p.quality} · ${p.scope} · ${p.source}\nSource observation ${when(p.observedAt)}${p.ingestedAt ? `\nIngested ${when(p.ingestedAt)}` : ''}${p.reason ? `\n${p.reason}` : ''}`;
  };
  return { when, provenance };
}
function duration(ms: number | null | undefined): string {
  if (!isKnown(ms)) return '—';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
const relative = (value: unknown, now: number) => relativeAge(value, now);
function Icon({ name, size = 18, className = '' }: { name: string; size?: number; className?: string }) {
  const paths: Record<string, ReactNode> = {
    pulse: <><path d="M2 12h5l3-8 4 16 3-8h5" /></>,
    context: <><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M9 1v3m6-3v3M9 20v3m6-3v3M1 9h3m-3 6h3m16-6h3m-3 6h3" /><rect x="8" y="8" width="8" height="8" rx="1" /></>,
    tokens: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v5c0 4 16 4 16 0V5M4 10v5c0 4 16 4 16 0v-5M4 15v4c0 4 16 4 16 0v-4" /></>,
    allowance: <><path d="M5 4h14v16H5zM8 8h8M8 12h5" /><path d="m12 15 2 2 4-4" /></>,
    tool: <><path d="M14 6a5 5 0 0 0-6.5 6.5L2 18l4 4 5.5-5.5A5 5 0 0 0 18 10l-4 4-4-4z" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></>,
    folder: <><path d="M3 6h6l2 2h10v12H3z" /><path d="M3 6V4h6l2 2h8v2" /></>,
    branch: <><circle cx="6" cy="4" r="2" /><circle cx="6" cy="20" r="2" /><circle cx="18" cy="6" r="2" /><path d="M6 6v12M6 15c0-7 12-1 12-7" /></>,
    agents: <><rect x="8" y="2" width="8" height="6" rx="2" /><path d="M12 8v5M4 17v-4h16v4" /><rect x="1" y="17" width="6" height="5" rx="1" /><rect x="9" y="17" width="6" height="5" rx="1" /><rect x="17" y="17" width="6" height="5" rx="1" /></>,
    file: <><path d="M5 2h9l5 5v15H5zM14 2v6h5M8 12h8m-8 4h6" /></>,
    history: <><path d="M3 10a9 9 0 1 1 1 7M3 4v6h6" /><path d="M12 7v5l3 2" /></>,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chevron: <path d="m8 4 8 8-8 8" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    shield: <><path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z" /><path d="m8 12 3 3 5-6" /></>,
    wave: <><path d="M3 18V8m6 10V3m6 15v-7m6 7V6" /></>,
    codex: <><path d="m9 5-7 7 7 7m6-14 7 7-7 7m-2-16-2 18" /></>,
    claude: <><path d="m12 2 1 7 6-5-4 7 8 1-8 2 5 7-7-5-1 7-2-7-7 4 5-6-7-2 7-1-4-7 6 5z" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{paths[name] ?? paths.info}</svg>;
}
function Status({ session, small = false }: { session: Session; small?: boolean }) {
  const { provenance } = useTimes();
  const state = session.state.value ?? 'unknown';
  return <span className={`status state-${state}${small ? ' small' : ''}`} title={provenance(session.state)}><span className="status-dot" />{stateNames[state]}{session.state.provenance.quality === 'stale' ? ' · stale' : ''}</span>;
}
function Card({ title, icon, children, className = '', action, hint }: { title: string; icon: string; children: ReactNode; className?: string; action?: ReactNode; hint?: string }) {
  return <section className={`card ${className}`} aria-label={title}><div className="card-heading"><h2><Icon name={icon} />{title}</h2>{action ?? (hint ? <span className="info-tip" tabIndex={0} title={hint} data-tooltip={hint} aria-label={hint}><Icon name="info" size={15} /></span> : null)}</div>{children}</section>;
}
function Gauge({ percent, value, label, color = 'green', title, stale = false }: { percent: number | null; value: string; label: string; color?: string; title: string; stale?: boolean }) {
  const measured = isKnown(percent);
  const safe = measured ? Math.min(100, Math.max(0, percent)) : 0;
  return <div className={`gauge ${color}${measured ? '' : ' unavailable'}${stale ? ' stale' : ''}`} title={title} role="img" aria-label={`${label}: ${value}${measured ? `, ${Math.round(safe)} percent` : ', unavailable'}`}>
    <svg viewBox="0 0 200 200" aria-hidden="true"><circle className="gauge-track" cx="100" cy="100" r="80" /><circle className="gauge-fill" cx="100" cy="100" r="80" pathLength="100" strokeDasharray={`${safe} 100`} transform="rotate(-90 100 100)" /></svg>
    <div className="gauge-value"><strong>{value}</strong><span>{label}</span></div>
  </div>;
}
function MetricBar({ label, value, max, color, note, title }: { label: string; value: number | null; max: number; color: string; note?: string; title?: string }) {
  return <div className="metric-bar" title={title}><div className="metric-bar-label"><span className={`legend-dot ${color}`} />{label}{note && <span className="bar-note">{note}</span>}</div><div className="bar-track"><span className={color} style={{ width: isKnown(value) && max > 0 ? `${Math.max(0, Math.min(100, value / max * 100))}%` : '0%' }} /></div><strong>{short(value)}</strong></div>;
}
function Empty({ icon = 'info', title, detail, compact: small = false }: { icon?: string; title: string; detail?: string; compact?: boolean }) {
  return <div className={`empty-state${small ? ' compact' : ''}`}><span className="empty-icon"><Icon name={icon} size={small ? 20 : 25} /></span><strong>{title}</strong>{detail && <p>{detail}</p>}</div>;
}
function ContextCard({ session }: { session: Session }) {
  const { provenance } = useTimes();
  const { used, capacity } = session.context;
  const percent = isKnown(used.value) && isKnown(capacity.value) && capacity.value > 0 ? used.value / capacity.value * 100 : null;
  return <Card title="Context window" icon="context" className="context-card" hint="Current context occupancy is separate from lifetime token usage. A ring is drawn only when both occupancy and capacity are reported.">
    <Gauge percent={percent} value={percent === null ? '—' : `${Math.round(percent)}%`} label={percent === null ? 'Not reported' : 'context used'} color={percent !== null && percent > 85 ? 'amber' : 'green'} title={`${provenance(used)}\n${provenance(capacity)}`} stale={used.provenance.quality === 'stale'} />
    <div className="gauge-caption"><strong>{short(used.value)}</strong><span>of {short(capacity.value)} tokens</span></div>
    <p className="card-footnote">{percent === null ? used.provenance.reason ?? 'The source does not report context occupancy.' : used.provenance.quality === 'stale' ? 'Last reported snapshot · stale' : 'Latest reported context snapshot'}</p>
  </Card>;
}
function TokensCard({ session }: { session: Session }) {
  const { provenance } = useTimes();
  const usage = session.usage.value;
  const max = Math.max(1, usage?.input ?? 0, usage?.output ?? 0, usage?.cachedInput ?? 0, usage?.cacheCreation ?? 0, usage?.reasoning ?? 0);
  const mainTotal = usage?.total;
  return <Card title="Session tokens" icon="tokens" className="tokens-card" hint={provenance(session.usage)}>
    <div className="token-total"><strong>{short(mainTotal)}</strong><span>lifetime tokens<span className="metric-quality">{session.usage.provenance.quality}{session.usage.provenance.quality === 'stale' ? ' snapshot' : ''}</span></span><span className="provider-token-note">Main agent</span></div>
    <div className="token-bars">
      <MetricBar label="Input" value={usage?.input ?? null} max={max} color="cyan" title="Codex includes cached input within input. Claude reports uncached input separately." />
      <MetricBar label="Output" value={usage?.output ?? null} max={max} color="purple" />
      <MetricBar label="Cache read" value={usage?.cachedInput ?? null} max={max} color="green" note={session.provider === 'codex' ? 'within input' : 'separate'} />
      {session.provider === 'claude' && <MetricBar label="Cache creation" value={usage?.cacheCreation ?? null} max={max} color="amber" note="separate" />}
      <MetricBar label="Reasoning" value={usage?.reasoning ?? null} max={max} color="amber" note="within output" />
    </div>
    <div className="turn-usage" title={provenance(session.turnUsage)}><span>Current turn</span><span><b>{short(session.turnUsage.value?.input)}</b> input</span><span><b>{short(session.turnUsage.value?.output)}</b> output</span></div>
  </Card>;
}
function AllowanceCard({ allowances, session, now }: { allowances: Allowance[]; session: Session; now: number }) {
  const { when, provenance } = useTimes();
  const main = allowances.find(a => isKnown(a.usedPercent.value)) ?? allowances[0];
  const used = main?.usedPercent.value;
  const stale = main?.usedPercent.provenance.quality === 'stale' || Boolean(main?.resetsAt && Date.parse(main.resetsAt) <= now);
  const remaining = isKnown(used) ? Math.max(0, 100 - used) : null;
  return <Card title="Account allowance" icon="allowance" className="allowance-card" hint="Allowances belong to the provider account and are shared across sessions. Expired snapshots remain stale until the provider reports fresh data.">
    {main ? <>
      <div className="allowance-main"><Gauge percent={remaining} value={remaining === null ? '—' : `${Math.round(remaining)}%`} label={stale ? 'last known remaining' : 'remaining'} color="cyan" title={provenance(main.usedPercent)} stale={stale} /><div className="allowance-info"><strong>{main.label}</strong><span>{main.windowMinutes ? `${duration(main.windowMinutes * 60000)} window` : 'Window not reported'}</span><span className={stale ? 'text-amber' : 'text-cyan'}>{stale ? 'Snapshot is stale' : main.resetsAt ? `Resets in ${duration(Date.parse(main.resetsAt) - now)}` : 'Reset not reported'}</span><small>Shared account allowance</small></div></div>
      <div className="allowance-windows">{allowances.map(a => { const expired = a.usedPercent.provenance.quality === 'stale' || Boolean(a.resetsAt && Date.parse(a.resetsAt) <= now); return <div className="allowance-window" key={a.id} title={`${provenance(a.usedPercent)}\nBucket: ${a.id}`}><div><span>{a.label}</span><strong>{isKnown(a.usedPercent.value) ? `${Math.round(Math.max(0, 100 - a.usedPercent.value))}% left` : 'Unavailable'}</strong></div><div className="bar-track"><span className={expired ? 'muted-fill' : 'cyan'} style={{ width: isKnown(a.usedPercent.value) ? `${Math.max(0, Math.min(100, 100 - a.usedPercent.value))}%` : '0%' }} /></div><small>{expired ? `Stale · reset ${when(a.resetsAt)}` : a.resetsAt ? `Resets ${when(a.resetsAt)}` : 'Reset time not reported'}</small></div>; })}</div>
    </> : <><div className="allowance-main"><Gauge percent={null} value="—" label="Unavailable" color="cyan" title="No supported account allowance source is available." /><div className="allowance-info"><strong>No allowance snapshot</strong><span>{session.provider === 'claude' ? 'Claude session discovery does not report subscription quota.' : 'No accessible, valid account snapshot has been reported.'}</span></div></div><p className="card-footnote">Monitoring continues without account allowance data.</p></>}
  </Card>;
}
function TrendChart({ session }: { session: Session }) {
  const { when } = useTimes();
  const values = session.trends.filter(p => Number.isFinite(Date.parse(p.at))).slice(-50);
  if (values.length < 2) return <Empty compact icon="wave" title="Collecting activity history" detail="The chart appears when at least two usage observations are available." />;
  const width = 620, height = 145, padding = 6;
  const max = Math.max(1, ...values.flatMap(p => [p.input, p.output]));
  const point = (i: number, v: number) => `${padding + i / (values.length - 1) * (width - padding * 2)},${height - padding - Math.max(0, v) / max * (height - padding * 2)}`;
  const inputPoints = values.map((p, i) => point(i, p.input)).join(' ');
  const outputPoints = values.map((p, i) => point(i, p.output)).join(' ');
  return <div className="trend-chart"><div className="chart-labels"><span>{short(max)}</span><span>Token observations</span></div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Input and output token observations over time"><line x1="0" y1={height / 2} x2={width} y2={height / 2} className="chart-grid" /><line x1="0" y1={height - padding} x2={width} y2={height - padding} className="chart-grid" /><polygon points={`${padding},${height} ${inputPoints} ${width - padding},${height}`} className="chart-area" /><polyline points={inputPoints} className="chart-line cyan" /><polyline points={outputPoints} className="chart-line purple" />{values.map((p, i) => <circle key={`${p.at}-${i}`} cx={padding + i / (values.length - 1) * (width - padding * 2)} cy={height - padding - Math.max(0, p.input) / max * (height - padding * 2)} r="3" className="chart-point"><title>{when(p.at)} · input {fmt(p.input)} · output {fmt(p.output)} · tools {fmt(p.tools)}</title></circle>)}</svg><div className="chart-axis"><span>{when(values[0].at, { hour: 'numeric', minute: '2-digit' })}</span><span><i className="legend-dot cyan" /> Input <i className="legend-dot purple" /> Output</span><span>{when(values[values.length - 1].at, { hour: 'numeric', minute: '2-digit' })}</span></div></div>;
}
function ToolsCard({ session }: { session: Session }) {
  const totals = session.tools.reduce((a, t) => ({ calls: a.calls + t.calls, success: a.success + t.succeeded, failed: a.failed + t.failed, unknown: a.unknown + t.unknown }), { calls: 0, success: 0, failed: 0, unknown: 0 });
  const known = totals.success + totals.failed;
  return <Card title="Tool performance" icon="tool" className="tools-card" hint="Success rate includes only calls with a known outcome. A missing duration or retry count stays unavailable.">
    <div className="tool-overview"><div><strong>{fmt(totals.calls)}</strong><span>observed calls</span></div><div className="tool-count text-green"><b>{fmt(totals.success)}</b><span>successful</span></div><div className="tool-count text-red"><b>{fmt(totals.failed)}</b><span>failed</span></div><div className="tool-count"><b>{fmt(totals.unknown)}</b><span>unknown</span></div></div>
    {session.tools.length ? <><div className="tool-success"><span>Known outcomes</span><div className="bar-track"><span className="green" style={{ width: known ? `${totals.success / known * 100}%` : '0%' }} /></div><strong>{known ? `${Math.round(totals.success / known * 100)}%` : '—'}</strong></div><div className="tool-table-wrap"><table className="tool-table"><thead><tr><th>Tool / category</th><th>Calls</th><th>Avg. time</th><th>Retries</th></tr></thead><tbody>{session.tools.slice().sort((a, b) => b.calls - a.calls).slice(0, 12).map(tool => <tr key={`${tool.name}:${tool.category}`}><td title={`${tool.succeeded} successful · ${tool.failed} failed · ${tool.unknown} unknown`}><span className={`tool-indicator ${tool.failed ? 'red' : tool.succeeded ? 'green' : 'muted-fill'}`} /><span><b>{tool.name}</b><small>{tool.category}</small></span></td><td>{fmt(tool.calls)}</td><td>{isKnown(tool.durationMs) && tool.calls > 0 ? duration(tool.durationMs / tool.calls) : '—'}</td><td>{fmt(tool.retries)}</td></tr>)}</tbody></table></div></> : <Empty compact icon="tool" title="No tool calls observed" detail="Only source-attributable tool invocations appear here." />}
  </Card>;
}
function TimingCard({ session, now }: { session: Session; now: number }) {
  const eta = session.timing.eta.value;
  const reportedElapsed = session.timing.elapsedMs.value;
  const elapsed = isKnown(reportedElapsed) && session.runtime.reachable && session.state.value === 'running' ? reportedElapsed + Math.max(0, now - Date.parse(session.timing.elapsedMs.provenance.observedAt)) : reportedElapsed;
  return <Card title="Timing & progress" icon="clock" className="timing-card"><div className="elapsed-metric" title={provenance(session.timing.elapsedMs)}><span>Session elapsed</span><strong>{duration(elapsed)}</strong></div><dl className="timing-details"><div><dt>Last activity</dt><dd title={when(session.lastActivityAt)}>{relative(session.lastActivityAt, now)}</dd></div><div><dt>Completed turns</dt><dd>{fmt(session.timing.completedTurns)}</dd></div><div><dt>Last turn</dt><dd title={provenance(session.timing.lastTurnMs)}>{duration(session.timing.lastTurnMs.value)}</dd></div><div><dt>Average turn</dt><dd title={provenance(session.timing.averageTurnMs)}>{duration(session.timing.averageTurnMs.value)}</dd></div></dl><div className="eta-block"><span>Estimated remaining</span><strong>{eta ? `${duration(eta.lowMs)} – ${duration(eta.highMs)}` : 'Not enough data yet'}</strong><p>{eta ? `${eta.confidence} confidence · ${eta.basis}` : session.timing.eta.provenance.reason ?? 'A reported checklist and comparable task durations are needed.'}</p>{session.timing.checklist && <div className="checklist"><div className="bar-track"><span className="green" style={{ width: session.timing.checklist.total ? `${Math.min(100, session.timing.checklist.completed / session.timing.checklist.total * 100)}%` : '0%' }} /></div><small>{session.timing.checklist.completed} of {session.timing.checklist.total} reported steps complete</small></div>}</div></Card>;
}
function MetadataCard({ session }: { session: Session }) {
  return <Card title="Session details" icon="folder" className="metadata-card"><dl className="metadata-list"><div><dt>Provider</dt><dd><Icon name={session.provider} size={14} />{providerNames[session.provider]}</dd></div><div><dt>Model</dt><dd title={provenance(session.model)}>{session.model.value ?? 'Not reported'}</dd></div><div><dt>Effort</dt><dd title={provenance(session.effort)}>{session.effort.value ?? 'Not reported'}</dd></div><div><dt>Project</dt><dd title={session.project ?? undefined}>{session.project ?? 'Not reported'}</dd></div><div><dt>Branch</dt><dd title={session.branch ?? undefined}><Icon name="branch" size={14} />{session.branch ?? 'Not reported'}</dd></div><div><dt>Started</dt><dd>{when(session.startedAt)}</dd></div><div className="full-width"><dt>Working directory</dt><dd className="mono wrap-text">{session.cwd ?? 'Not reported'}</dd></div><div className="full-width"><dt>Native session ID</dt><dd className="mono wrap-text">{session.nativeId}</dd></div><div className="full-width"><dt>Source namespace</dt><dd className="mono wrap-text">{session.namespace}</dd></div>{session.forkedFromId && <div className="full-width"><dt>Forked from</dt><dd className="mono wrap-text">{session.forkedFromId}</dd></div>}</dl><div className="runtime-evidence"><span className={`status-dot ${session.runtime.reachable ? 'green' : 'muted-fill'}`} /><span>{session.runtime.reachable ? `Runtime reachable${session.runtime.loaded ? ' · thread loaded' : ''}${session.runtime.pid ? ` · PID ${session.runtime.pid}` : ''}` : 'Runtime not confirmed · persisted history'}<small>{session.runtime.attachment === 'known' ? 'Terminal attachment known' : 'Terminal attachment unknown'}</small></span></div></Card>;
}
function SubagentsCard({ session, children }: { session: Session; children: Session[] }) {
  const allTotals = children.map(s => s.usage.value?.total ?? null);
  const total = children.length && allTotals.every(isKnown) ? allTotals.reduce<number>((a, b) => a + (b ?? 0), 0) : null;
  const main = session.usage.value?.total;
  const inclusive = isKnown(main) && isKnown(total) ? main + total : null;
  return <Card title="Subagents" icon="agents" className="subagents-card" hint="Main and child usage stay separate. Inclusive usage is shown only when each contribution is known."><div className="subagent-summary"><strong>{children.length}</strong><span>observed subagent{children.length === 1 ? '' : 's'}</span><span className="text-purple">{short(total)} tokens</span></div>{children.length ? <><ul className="subagent-list">{children.map(child => <li key={child.id}><span className={`provider-mark ${child.provider}`}><Icon name={child.provider} size={15} /></span><div><strong title={child.name}>{child.name}</strong><span>{child.model.value ?? child.nativeId.slice(0, 12)}</span></div><div><Status session={child} small /><span>{short(child.usage.value?.total)} tokens</span></div></li>)}</ul><div className="inclusive-total"><span>Main + subagents</span><strong>{short(inclusive)} <small>tokens</small></strong></div></> : <Empty compact icon="agents" title="No subagents observed" detail="Child sessions appear here when native parent metadata is available." />}</Card>;
}
function AttributionCard({ session }: { session: Session }) {
  const edits = session.edits.value;
  return <Card title="Observed changes" icon="file" className="edits-card" hint={provenance(session.edits)}><div className="edit-metrics"><div><strong>{fmt(edits?.files)}</strong><span>attributable files</span></div><div><b className="text-green">{isKnown(edits?.additions) ? `+${fmt(edits?.additions)}` : '—'}</b><span>additions</span></div><div><b className="text-red">{isKnown(edits?.deletions) ? `−${fmt(edits?.deletions)}` : '—'}</b><span>deletions</span></div></div><p className="card-footnote">{session.edits.provenance.reason ?? 'Edits observed in this session’s native tool records. Shared workspace changes may have other authors.'}</p><div className="cost-block"><span>API-equivalent estimate</span><strong>{session.cost.value ? `$${session.cost.value.usd.toFixed(2)}` : 'Unavailable'}</strong><p>{session.cost.value?.label ?? session.cost.provenance.reason ?? 'Complete usage categories and known model pricing are required.'}</p><small>Not a subscription invoice</small></div></Card>;
}
function RecentActivity({ session }: { session: Session }) {
  const activities = session.activities.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 12);
  return <Card title="Recent activity" icon="pulse" className="recent-card" action={<span className="muted small-copy">Source observations</span>}>{activities.length ? <ol className="activity-list">{activities.map((a, i) => <li key={`${a.id}-${i}`}><span className={`activity-symbol ${a.outcome === 'failure' ? 'text-red' : a.outcome === 'success' ? 'text-green' : a.kind === 'usage' ? 'text-cyan' : 'text-purple'}`}><Icon name={a.kind === 'tool' ? 'tool' : a.kind === 'edit' ? 'file' : a.kind === 'usage' ? 'tokens' : a.kind === 'turn' ? 'check' : 'pulse'} size={15} /></span><div><strong>{a.label}</strong>{a.detail && <p>{a.detail}</p>}</div><time dateTime={a.at} title={when(a.at)}>{when(a.at, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time></li>)}</ol> : <Empty compact icon="pulse" title="Waiting for observable activity" detail="Metadata and metrics will update automatically as native sources change." />}</Card>;
}
function SessionSummary({ session }: { session: Session }) {
  const state = session.state.value ?? 'unknown';
  return <section className={`session-summary summary-${state}`} aria-label="Session summary"><span className="summary-icon"><Icon name={state === 'complete' ? 'check' : 'pulse'} size={25} /></span><div><span className="summary-label">Session summary</span><h2>{session.latestActivity || stateNames[state]}</h2><p>{session.runtime.reachable ? 'Live runtime evidence available.' : 'Viewing persisted session evidence; runtime activity is unconfirmed.'} {session.timing.completedTurns ? `${session.timing.completedTurns} completed turn${session.timing.completedTurns === 1 ? '' : 's'} observed.` : ''}</p></div><div className="summary-state"><Status session={session} /><span>{when(session.lastActivityAt)}</span></div></section>;
}
function chooseInitial(sessions: Session[]) {
  return sessions.find(s => !s.parentId && s.state.value === 'running')?.id ?? sessions.find(s => !s.parentId && s.runtime.reachable)?.id ?? sessions.filter(s => !s.parentId).sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))[0]?.id ?? null;
}
function readSelection() { try { return localStorage.getItem(SELECTION_KEY); } catch { return null; } }
function useMonitor() {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useRef({ revision: -1, observedAt: 0 });
  useEffect(() => {
    let active = true;
    let refreshing = false;
    const receive = (incoming: Snapshot) => {
      if (!active || !incoming || !Array.isArray(incoming.sessions) || typeof incoming.revision !== 'number') return;
      // Do not let an earlier HTTP response overwrite a newer stream update. A server
      // restart may reset revisions, so observation time also identifies fresh snapshots.
      const observedAt = Date.parse(incoming.observedAt) || 0;
      if (observedAt < latest.current.observedAt) return;
      latest.current = { revision: incoming.revision, observedAt };
      setSnapshot(incoming);
      setFailure(null);
    };
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const response = await fetch('/api/snapshot', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error(`Dashboard returned ${response.status}`);
        receive(await response.json() as Snapshot);
      } catch (error) { if (active) setFailure(error instanceof Error ? error.message : 'The local dashboard is unavailable.'); }
      finally { refreshing = false; }
    };
    void refresh();
    const stream = new EventSource('/api/events');
    stream.addEventListener('open', () => { if (active) { setConnection('live'); void refresh(); } });
    stream.addEventListener('snapshot', event => {
      try { receive(JSON.parse((event as MessageEvent<string>).data) as Snapshot); if (active) setConnection('live'); }
      catch { void refresh(); }
    });
    stream.addEventListener('resync', () => void refresh());
    stream.addEventListener('error', () => { if (active) setConnection('reconnecting'); });
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30000);
    return () => { active = false; stream.close(); window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);
  return { snapshot, connection, failure };
}
function DiagnosticsPanel({ snapshot, session, onClose }: { snapshot: Snapshot; session: Session | undefined; onClose: () => void }) {
  const rows: Diagnostic[] = [...snapshot.diagnostics, ...(session?.diagnostics ?? [])];
  return <aside className="diagnostics-panel" aria-label="Source diagnostics"><div className="panel-heading"><div><h2>Source diagnostics</h2><p>Read-only observation and source coverage</p></div><button className="icon-button" aria-label="Close source diagnostics" onClick={onClose}><Icon name="close" /></button></div><div className="diagnostic-meta"><span>Snapshot revision <b>{snapshot.revision}</b></span><span>Observed <b>{when(snapshot.observedAt)}</b></span><span>Collector <b>{snapshot.collecting ? 'Reconciling' : 'Observing'}</b></span></div>{rows.length ? <ul className="diagnostic-list">{rows.map((d, i) => <li key={`${d.code}-${i}`} className={`diagnostic-${d.level}`}><Icon name="info" size={16} /><div><strong>{d.provider ? `${providerNames[d.provider]} · ` : ''}{d.code.replaceAll('_', ' ')}</strong><p>{d.message}</p>{d.namespace && <small className="mono wrap-text">{d.namespace}</small>}</div></li>)}</ul> : <p className="diagnostic-none">No source issues reported in this snapshot.</p>}{session && <details className="metric-sources"><summary>Metric provenance</summary>{[['State', session.state], ['Session tokens', session.usage], ['Current turn', session.turnUsage], ['Context occupancy', session.context.used], ['Context capacity', session.context.capacity], ['Effort', session.effort], ['Edits', session.edits], ['ETA', session.timing.eta]].map(([label, value]) => <div key={String(label)}><strong>{String(label)}</strong><p>{provenance(value as Metric<unknown>)}</p></div>)}</details>}</aside>;
}
function HistoryPanel({ sessions, selectedId, select, onClose, now }: { sessions: Session[]; selectedId: string | null; select: (id: string) => void; onClose: () => void; now: number }) {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState<'all' | 'codex' | 'claude'>('all');
  const filtered = sessions.filter(s => !s.parentId && (provider === 'all' || s.provider === provider) && `${s.name} ${s.nativeId} ${s.cwd} ${s.model.value}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.runtime.reachable) - Number(a.runtime.reachable) || (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  return <aside className="history-panel" aria-label="Session history"><div className="panel-heading"><div><h2>Session history</h2><p>{sessions.filter(s => !s.parentId).length} conversations discovered automatically</p></div><button className="icon-button" aria-label="Close session history" onClick={onClose}><Icon name="close" /></button></div><div className="history-controls"><label className="search-field"><Icon name="search" size={17} /><input autoFocus type="search" placeholder="Search name, project, or ID" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search session history" /></label><select value={provider} onChange={e => setProvider(e.target.value as typeof provider)} aria-label="Filter session provider"><option value="all">All providers</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select></div><div className="history-list">{filtered.length ? filtered.map(s => <button key={s.id} className={`history-item${s.id === selectedId ? ' selected' : ''}`} onClick={() => { select(s.id); onClose(); }}><span className={`provider-mark ${s.provider}`}><Icon name={s.provider} /></span><span className="history-item-content"><strong>{s.name}</strong><span>{s.project ?? s.cwd ?? s.nativeId}</span><small>{providerNames[s.provider]} · {relative(s.lastActivityAt, now)}{s.archived ? ' · archived' : ''}</small></span><Status session={s} small /></button>) : <Empty compact icon="search" title="No matching sessions" detail="Try a different name, path, or provider." />}</div></aside>;
}
export default function App() {
  const { snapshot, connection, failure } = useMonitor();
  const [selectedId, setSelectedId] = useState<string | null>(readSelection);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const mainSessions = useMemo(() => snapshot.sessions.filter(s => !s.parentId), [snapshot.sessions]);
  const selected = snapshot.sessions.find(s => s.id === selectedId);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    // During initial backfill, retain a saved selection until its source is enumerated.
    if (!selected && mainSessions.length && (!selectedId || !snapshot.collecting)) setSelectedId(chooseInitial(mainSessions));
  }, [mainSessions, selected, selectedId, snapshot.collecting]);
  useEffect(() => { if (selectedId) { try { localStorage.setItem(SELECTION_KEY, selectedId); } catch { /* Storage may be disabled by browser policy. */ } } }, [selectedId]);
  useEffect(() => { document.title = selected ? selected.name : 'Agent Monitor'; }, [selected?.name]);
  useEffect(() => { const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { setHistoryOpen(false); setDiagnosticsOpen(false); } }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, []);
  const recent = mainSessions.slice().sort((a, b) => Number(b.runtime.reachable) - Number(a.runtime.reachable) || (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
  const visibleIds = new Set([...recent.filter(s => s.runtime.reachable).map(s => s.id), ...recent.slice(0, 8).map(s => s.id), ...(selectedId ? [selectedId] : [])]);
  const tabs = recent.filter(s => visibleIds.has(s.id));
  const children = selected ? snapshot.sessions.filter(s => s.parentId === selected.id || (s.parentId === selected.nativeId && s.namespace === selected.namespace && s.provider === selected.provider)) : [];
  const allowances = selected ? snapshot.allowances.filter(a => selected.allowanceIds.includes(a.id)) : [];
  const liveCount = mainSessions.filter(s => s.runtime.reachable).length;
  const warnings = snapshot.diagnostics.filter(d => d.level !== 'info').length + (selected?.diagnostics.filter(d => d.level !== 'info').length ?? 0);
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== null) { event.preventDefault(); setSelectedId(tabs[next].id); tabRefs.current.get(tabs[next].id)?.focus(); }
  };
  return <div className="app-shell"><a className="skip-link" href="#session-dashboard">Skip to dashboard</a><div className="topbar"><a href="/" className="brand" aria-label="Agent Monitor home"><span className="brand-symbol"><Icon name="pulse" size={22} /></span><span>Agent Monitor</span><span className="local-label">Local</span></a><div className="topbar-actions"><span className={`connection ${connection}`} role="status"><span className="status-dot" />{connection === 'live' ? 'Live updates' : connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</span><button className={`text-button${historyOpen ? ' active' : ''}`} onClick={() => { setHistoryOpen(v => !v); setDiagnosticsOpen(false); }} aria-expanded={historyOpen}><Icon name="history" size={17} /><span>History</span><span className="button-count">{mainSessions.length}</span></button><button className={`text-button diagnostics-button${diagnosticsOpen ? ' active' : ''}`} onClick={() => { setDiagnosticsOpen(v => !v); setHistoryOpen(false); }} aria-expanded={diagnosticsOpen}><Icon name="info" size={17} /><span>Sources</span>{warnings > 0 && <span className="warning-count">{warnings}</span>}</button></div></div>
    {failure && <div className="connection-banner" role="alert"><Icon name="info" />{failure}. Showing the last available snapshot while reconnecting.</div>}
    {connection === 'reconnecting' && !failure && <div className="connection-banner" role="status"><Icon name="info" />Reconnecting to the local observer. Your selection and last snapshot are preserved.</div>}
    {selected ? <header className="session-header"><div className={`session-avatar ${selected.provider}`}><Icon name={selected.provider} size={28} /></div><div className="session-heading"><div className="session-heading-top"><span>{providerNames[selected.provider]}</span><span className="separator">/</span><span>{selected.model.value ?? 'Model not reported'}</span>{selected.effort.value && <span className="effort-label">{selected.effort.value}</span>}</div><h1 title={selected.name}>{selected.name}</h1><p><Icon name="folder" size={14} /><span title={selected.cwd ?? undefined}>{selected.project ?? selected.cwd ?? 'Working directory not reported'}</span><span className="header-native-id" title={selected.nativeId}>{selected.nativeId.slice(0, 8)}</span></p></div><div className="header-status"><Status session={selected} /><span><Icon name="clock" size={14} />{duration(selected.timing.elapsedMs.value)} elapsed</span></div></header> : <header className="waiting-header"><h1>Your agents, in view.</h1><p>Existing Codex and Claude Code sessions appear automatically as local sources are discovered.</p></header>}
    {tabs.length > 0 && <nav className="sessions-nav" aria-label="Session navigation"><div className="sessions-tabs" role="tablist" aria-label="Sessions">{tabs.map((s, i) => <button key={s.id} id={`tab-${encodeURIComponent(s.id)}`} role="tab" aria-selected={s.id === selectedId} aria-controls="session-dashboard" tabIndex={s.id === selectedId ? 0 : -1} ref={element => { if (element) tabRefs.current.set(s.id, element); else tabRefs.current.delete(s.id); }} onKeyDown={event => onTabKey(event, i)} onClick={() => setSelectedId(s.id)} className={`session-tab ${s.provider}${s.id === selectedId ? ' selected' : ''}`} title={`${s.name}\n${providerNames[s.provider]} · ${stateNames[s.state.value ?? 'unknown']}\n${s.nativeId}`}><Icon name={s.provider} size={16} /><span>{s.name}</span><span className={`tab-state state-${s.state.value ?? 'unknown'}`} /></button>)}</div>{mainSessions.length > tabs.length && <button className="all-sessions" onClick={() => { setHistoryOpen(true); setDiagnosticsOpen(false); }} aria-label={`View all ${mainSessions.length} sessions`}>+{mainSessions.length - tabs.length}<Icon name="chevron" size={13} /></button>}</nav>}
    <div className="session-counts"><span><span className="status-dot green" />{liveCount} runtime{liveCount === 1 ? '' : 's'} confirmed<span className="counts-divider">·</span>{mainSessions.length - liveCount} with unconfirmed runtime</span><span>{snapshot.collecting ? 'Discovering local sources…' : 'Observing local sources'}<span className="counts-divider">·</span>{snapshot.observedAt ? `Updated ${relative(snapshot.observedAt, now).toLowerCase()}` : 'First snapshot pending'}</span></div>
    {historyOpen && <HistoryPanel sessions={snapshot.sessions} selectedId={selectedId} select={setSelectedId} onClose={() => setHistoryOpen(false)} now={now} />}
    {diagnosticsOpen && <DiagnosticsPanel snapshot={snapshot} session={selected} onClose={() => setDiagnosticsOpen(false)} />}
    <main id="session-dashboard" role={selected ? 'tabpanel' : undefined} aria-labelledby={selected ? `tab-${encodeURIComponent(selected.id)}` : undefined} tabIndex={-1}>{selected ? <><div className="dashboard-grid"><ContextCard session={selected} /><TokensCard session={selected} /><AllowanceCard session={selected} allowances={allowances} now={now} /><ToolsCard session={selected} /><Card title="Token activity" icon="wave" className="activity-card" hint="Observed input and output token snapshots from the source. These observations do not indicate task progress."><TrendChart session={selected} /><div className="activity-stats"><div><strong>{fmt(selected.timing.completedTurns)}</strong><span>completed turns</span></div><div><strong>{duration(selected.timing.lastTurnMs.value)}</strong><span>last turn</span></div><div><strong>{relative(selected.lastActivityAt, now)}</strong><span>last activity</span></div></div></Card><TimingCard session={selected} now={now} /><MetadataCard session={selected} /><SubagentsCard session={selected} children={children} /><AttributionCard session={selected} /><RecentActivity session={selected} /></div><SessionSummary session={selected} /></> : <div className="waiting-dashboard"><div className="waiting-orbit"><Icon name="pulse" size={46} /></div><h2>{snapshot.collecting ? 'Discovering your sessions' : 'Waiting for your agents'}</h2><p>Launch Codex or Claude Code normally. Sessions already on this computer and sessions you start later appear here automatically.</p><div className="waiting-providers"><span><Icon name="codex" />Codex</span><span><Icon name="claude" />Claude Code</span></div><button className="text-button" onClick={() => setDiagnosticsOpen(true)}><Icon name="info" />View source diagnostics</button></div>}</main><footer><span><Icon name="shield" size={14} />Private by default · local observation only</span><span>Agent Monitor<span className="counts-divider">·</span>No model calls</span></footer>
  </div>;
}
