import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Allowance, Diagnostic, Metric, Session, Snapshot } from '../shared/types.js';
import type { ObserverSnapshot } from '../shared/observer.js';
import { compareTimestamps, epochMilliseconds, formatTimestamp, relativeAge } from '../shared/time.js';
import TimingPanel from './TimingPanel.js';
import DetailDrawer from './DetailDrawer.js';
import { defaultSelection, filteredSessionCollection, observerRequest, sessionTabs, type SessionFilters } from './ui-model.js';
import { browserAuthorizationRevision, localFetch } from './http.js';
import { chronologicalActivities, limitSessionTabs, nextTabIndex, reportedActivityAt, runtimePresentation } from './presentation.js';
import { sessionEligibility } from '../shared/lifecycle.js';

const SELECTION_KEY = 'agent-monitor.selected-session';
const n = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const providerNames = { codex: 'Codex', claude: 'Claude Code' };
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
const brief = (value: string, limit = 110) => value.length <= limit ? value : `${value.slice(0, limit).replace(/\s+\S*$/, '')}…`;
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
export function Status({ session, small = false, now = Date.now(), diagnostics = [] }: { session: Session; small?: boolean; now?: number; diagnostics?: Diagnostic[] }) {
  const { when, provenance } = useTimes();
  const view = runtimePresentation(session, now, diagnostics);
  const age = ['Activity observed', 'Recorded turn open', 'Task recorded active'].includes(view.label) && view.evidenceAt ? relative(view.evidenceAt, now) : null;
  const timestamp = view.evidenceAt ? `Source activity ${when(view.evidenceAt, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'No activity timestamp reported';
  return <span className={`status state-${view.tone}${small ? ' small' : ''}`} title={`${view.detail}\n${timestamp}\n${provenance(session.state)}`}><span className="status-dot" />{view.label}{age && <span className="status-age"> · {age}</span>}</span>;
}
function Card({ title, icon, children, className = '', action, hint }: { title: string; icon: string; children: ReactNode; className?: string; action?: ReactNode; hint?: string }) {
  return <section className={`card ${className}`} aria-label={title}><div className="card-heading"><h2><Icon name={icon} />{title}</h2>{action ?? (hint ? <span className="info-tip" tabIndex={0} title={hint} data-tooltip={hint} aria-label={hint}><Icon name="info" size={15} /></span> : null)}</div>{children}</section>;
}
function Gauge({ percent, value, label, color = 'green', title, stale = false, unavailableReason, unavailableLabel = 'Not reported' }: { percent: number | null; value: string; label: string; color?: string; title: string; stale?: boolean; unavailableReason?: string; unavailableLabel?: string }) {
  if (percent === null || !Number.isFinite(percent) || percent < 0 || percent > 100) return <div className={`gauge gauge-condition ${color}`} title={title} role="status"><div><strong>{unavailableLabel}</strong><p>{unavailableReason || 'The native source has not reported a valid percentage.'}</p></div></div>;
  const safe = Math.min(100, Math.max(0, percent));
  return <div className={`gauge ${color}${stale ? ' stale' : ''}`} title={title} role="img" aria-label={`${label}: ${value}, ${Math.round(safe)} percent`}>
    <svg viewBox="0 0 200 200" aria-hidden="true"><circle className="gauge-track" cx="100" cy="100" r="80" /><circle className="gauge-fill" cx="100" cy="100" r="80" pathLength="100" strokeDasharray={`${safe} 100`} transform="rotate(-90 100 100)" /></svg>
    <div className="gauge-value"><strong>{value}</strong><span>{label}</span></div>
  </div>;
}
function MetricBar({ label, value, max, color, title }: { label: string; value: number | null; max: number; color: string; title?: string }) {
  return <div className="metric-bar" title={title}><div className="metric-bar-label"><span className={`legend-dot ${color}`} />{label}</div><div className="bar-track"><span className={color} style={{ width: isKnown(value) && max > 0 ? `${Math.max(0, Math.min(100, value / max * 100))}%` : '0%' }} /></div><strong>{short(value)}</strong></div>;
}
function Empty({ icon = 'info', title, detail, compact: small = false }: { icon?: string; title: string; detail?: string; compact?: boolean }) {
  return <div className={`empty-state${small ? ' compact' : ''}`}><span className="empty-icon"><Icon name={icon} size={small ? 20 : 25} /></span><strong>{title}</strong>{detail && <p>{detail}</p>}</div>;
}
function ContextCard({ session }: { session: Session }) {
  const { provenance } = useTimes();
  const { used, capacity } = session.context;
  const modelLimit = session.context.capacityBasis === 'model-limit';
  const stale = used.provenance.quality === 'stale' || capacity.provenance.quality === 'stale';
  const percent = isKnown(used.value) && used.value >= 0 && isKnown(capacity.value) && capacity.value > 0 && used.value <= capacity.value ? used.value / capacity.value * 100 : null;
  const unavailableReason = !isKnown(used.value) || used.value < 0 ? used.provenance.reason || 'Context occupancy is not reported.' : !isKnown(capacity.value) || capacity.value <= 0 ? capacity.provenance.reason || 'A positive context capacity has not been reported.' : 'Reported context occupancy exceeds the reported capacity.';
  return <Card title="Context window" icon="context" className="context-card" hint={`${provenance(used)}\n${provenance(capacity)}`}>
    <div className="context-overview"><Gauge percent={percent} value={percent === null ? '—' : `${Math.round(percent)}%`} label={modelLimit ? 'of model limit' : 'context used'} color={percent !== null && percent > 85 ? 'amber' : 'green'} title={percent === null ? unavailableReason : `${provenance(used)}\n${provenance(capacity)}`} stale={stale} unavailableLabel={used.value !== null && capacity.value === null ? 'Limit unavailable' : 'Context unavailable'} unavailableReason={unavailableReason} />
      <dl className="context-numbers"><div><dt>{modelLimit ? 'Latest input' : 'Used'}</dt><dd title={provenance(used)}>{short(used.value)}</dd></div><div><dt>{modelLimit ? 'To model limit' : 'Remaining'}</dt><dd className="text-green">{percent === null ? '—' : short(capacity.value! - used.value!)}</dd></div><div><dt>{modelLimit ? 'Model limit' : 'Capacity'}</dt><dd title={provenance(capacity)}>{short(capacity.value)}</dd></div></dl>
    </div>{modelLimit ? <p className="card-footnote" title={`${provenance(used)}\n${provenance(capacity)}`}>Latest request · {capacity.provenance.quality === 'stale' ? 'cached model limit' : 'native model limit'} · compaction may occur sooner</p> : stale && <p className="card-footnote text-amber">Last reported snapshot · stale</p>}
  </Card>;
}

function TokensCard({ session }: { session: Session }) {
  const { provenance } = useTimes();
  const [details, setDetails] = useState(false);
  const usage = session.usage.value;
  const max = Math.max(1, usage?.input ?? 0, usage?.output ?? 0, usage?.cachedInput ?? 0, usage?.cacheCreation ?? 0, usage?.reasoning ?? 0);
  const mainTotal = usage?.total;
  return <Card title="Session tokens" icon="tokens" className="tokens-card" action={<button className="detail-link" onClick={() => setDetails(true)}>Trend & details</button>}>
    <div className="token-total"><strong>{short(mainTotal)}</strong><span title={provenance(session.usage)}>lifetime tokens{session.usage.provenance.quality === 'stale' && <span className="metric-quality">Stale snapshot</span>}</span><span className="provider-token-note">Main agent</span></div>
    <div className="token-bars">
      <MetricBar label="Input" value={usage?.input ?? null} max={max} color="cyan" title="Codex includes cached input within input. Claude reports uncached input separately." />
      <MetricBar label="Output" value={usage?.output ?? null} max={max} color="purple" />
      <MetricBar label="Cache read" value={usage?.cachedInput ?? null} max={max} color="green" title={session.provider === 'codex' ? 'Included within input' : 'Separate from uncached input'} />
      {session.provider === 'claude' && <MetricBar label="Cache creation" value={usage?.cacheCreation ?? null} max={max} color="amber" title="Separate from uncached input" />}
      <MetricBar label="Reasoning" value={usage?.reasoning ?? null} max={max} color="amber" title="Included within output" />
    </div>
    <div className="turn-usage" title={provenance(session.turnUsage)}><span>Current turn</span><span><b>{short(session.turnUsage.value?.input)}</b> input</span><span><b>{short(session.turnUsage.value?.output)}</b> output</span></div>
    {details && <DetailDrawer title="Token usage & trend" onClose={() => setDetails(false)}><TrendChart session={session} /><p className="card-footnote">Token observations describe consumption, not task progress.</p><dl className="timing-details"><div><dt>Completed turns</dt><dd>{fmt(session.timing.completedTurns)}</dd></div><div><dt>Last turn</dt><dd>{duration(session.timing.lastTurnMs.value)}</dd></div></dl><p className="source-detail">{provenance(session.usage)}</p><p className="source-detail">{provenance(session.turnUsage)}</p></DetailDrawer>}
  </Card>;
}
function AllowanceCard({ allowances, session, now }: { allowances: Allowance[]; session: Session; now: number }) {
  const { when, provenance } = useTimes();
  const [details, setDetails] = useState(false);
  const main = allowances.find(a => isKnown(a.usedPercent.value)) ?? allowances[0];
  const used = main?.usedPercent.value;
  const reset = epochMilliseconds(main?.resetsAt);
  const stale = main?.usedPercent.provenance.quality === 'stale' || (reset !== null && reset <= now);
  const remaining = isKnown(used) && used >= 0 && used <= 100 ? 100 - used : null;
  const windowRow = (a: Allowance) => {
    const resetAt = epochMilliseconds(a.resetsAt);
    const expired = a.usedPercent.provenance.quality === 'stale' || (resetAt !== null && resetAt <= now);
    const valid = isKnown(a.usedPercent.value) && a.usedPercent.value >= 0 && a.usedPercent.value <= 100;
    return <div className="allowance-window" key={a.id} title={provenance(a.usedPercent)}><div><span>{a.label}</span><strong>{valid ? `${Math.round(100 - a.usedPercent.value!)}% left` : 'Unavailable'}</strong></div>{valid && <div className="bar-track"><span className={expired ? 'muted-fill' : 'cyan'} style={{ width: `${100 - a.usedPercent.value!}%` }} /></div>}<small title={when(a.resetsAt)}>{expired ? 'Stale snapshot' : resetAt !== null ? `Resets in ${duration(resetAt - now)}` : 'Reset not reported'}</small></div>;
  };
  return <Card title="Account allowance" icon="allowance" className="allowance-card" action={<button className="detail-link" onClick={() => setDetails(true)}>Details</button>}>
    {main ? <><div className="allowance-main"><Gauge percent={remaining} value={remaining === null ? '—' : `${Math.round(remaining)}%`} label={stale ? 'last known' : 'remaining'} color="cyan" title={provenance(main.usedPercent)} stale={stale} unavailableLabel="Unavailable" unavailableReason="No valid percentage" /><div className="allowance-info"><strong>{main.label}</strong><span>{main.windowMinutes ? `${duration(main.windowMinutes * 60000)} window` : 'Window not reported'}</span><span title={when(main.resetsAt)} className={stale ? 'text-amber' : 'text-cyan'}>{stale ? 'Stale snapshot' : reset !== null ? `Resets in ${duration(reset - now)}` : 'Reset not reported'}</span></div></div><div className="allowance-windows">{allowances.filter(a => a !== main).slice(0, 1).map(windowRow)}</div></> : <p className="compact-empty">{session.provider === 'claude' ? 'Claude quota is not reported by session discovery.' : 'No account allowance snapshot available.'}</p>}
    {details && <DetailDrawer title="Account allowance" onClose={() => setDetails(false)}><p className="card-footnote">Shared across this provider account’s sessions. Expired snapshots stay stale until fresh data arrives.</p>{allowances.length ? <div className="allowance-windows">{allowances.map(a => <div key={a.id}>{windowRow(a)}<p className="source-detail">{provenance(a.usedPercent)}{`\nReset: ${when(a.resetsAt)}\nBucket: ${a.id}`}</p></div>)}</div> : <p className="compact-empty">No supported allowance payload has been observed. Session monitoring continues.</p>}</DetailDrawer>}
  </Card>;
}
function TrendChart({ session }: { session: Session }) {
  const { when } = useTimes();
  const values = session.trends.filter(p => epochMilliseconds(p.at) !== null).sort((a, b) => compareTimestamps(a.at, b.at)).slice(-50);
  if (values.length < 2) return <Empty compact icon="wave" title="Collecting activity history" detail="The chart appears when at least two usage observations are available." />;
  const width = 620, height = 145, padding = 6;
  const max = Math.max(1, ...values.flatMap(p => [p.input, p.output]));
  const point = (i: number, v: number) => `${padding + i / (values.length - 1) * (width - padding * 2)},${height - padding - Math.max(0, v) / max * (height - padding * 2)}`;
  const inputPoints = values.map((p, i) => point(i, p.input)).join(' ');
  const outputPoints = values.map((p, i) => point(i, p.output)).join(' ');
  return <div className="trend-chart"><div className="chart-labels"><span>{short(max)}</span><span>Token observations</span></div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Input and output token observations over time"><line x1="0" y1={height / 2} x2={width} y2={height / 2} className="chart-grid" /><line x1="0" y1={height - padding} x2={width} y2={height - padding} className="chart-grid" /><polygon points={`${padding},${height} ${inputPoints} ${width - padding},${height}`} className="chart-area" /><polyline points={inputPoints} className="chart-line cyan" /><polyline points={outputPoints} className="chart-line purple" />{values.map((p, i) => <circle key={`${p.at}-${i}`} cx={padding + i / (values.length - 1) * (width - padding * 2)} cy={height - padding - Math.max(0, p.input) / max * (height - padding * 2)} r="3" className="chart-point"><title>{when(p.at)} · input {fmt(p.input)} · output {fmt(p.output)} · tools {fmt(p.tools)}</title></circle>)}</svg><div className="chart-axis"><span>{when(values[0].at, { hour: 'numeric', minute: '2-digit' })}</span><span><i className="legend-dot cyan" /> Input <i className="legend-dot purple" /> Output</span><span>{when(values[values.length - 1].at, { hour: 'numeric', minute: '2-digit' })}</span></div></div>;
}
function ToolTable({ tools, preview = false }: { tools: Session['tools']; preview?: boolean }) {
  return <table className="tool-table"><thead><tr><th>Tool</th><th>Calls</th><th>Avg. time</th><th>Retries</th></tr></thead><tbody>{tools.map(tool => <tr key={`${tool.name}:${tool.category}`}><td title={`${tool.name} · ${tool.category} · ${tool.succeeded} successful · ${tool.failed} failed · ${tool.unknown} unknown · ${fmt(tool.inFlight)} in flight · ${fmt(tool.pending)} awaiting result · ${fmt(tool.interrupted)} interrupted`}><span className={`tool-indicator ${tool.failed ? 'red' : tool.succeeded ? 'green' : 'muted-fill'}`} /><span><b>{preview ? brief(tool.name, 36) : tool.name}</b></span></td><td>{fmt(tool.calls)}</td><td>{isKnown(tool.durationMs) && tool.calls > 0 ? duration(tool.durationMs / tool.calls) : '—'}</td><td>{fmt(tool.retries)}</td></tr>)}</tbody></table>;
}
function ToolsCard({ session }: { session: Session }) {
  const [details, setDetails] = useState(false);
  const totals = session.tools.reduce((a, t) => ({ calls: a.calls + t.calls, success: a.success + t.succeeded, failed: a.failed + t.failed, unknown: a.unknown + t.unknown }), { calls: 0, success: 0, failed: 0, unknown: 0 });
  const known = totals.success + totals.failed;
  const inFlight = session.tools.some(t => isKnown(t.inFlight)) ? session.tools.reduce((sum, tool) => sum + (tool.inFlight ?? 0), 0) : null;
  const pending = session.tools.some(t => isKnown(t.pending)) ? session.tools.reduce((sum, tool) => sum + (tool.pending ?? 0), 0) : null;
  const tools = session.tools.slice().sort((a, b) => ((b.inFlight ?? 0) + (b.pending ?? 0)) - ((a.inFlight ?? 0) + (a.pending ?? 0)) || b.calls - a.calls);
  return <Card title="Tool performance" icon="tool" className="tools-card" action={<button className="detail-link" onClick={() => setDetails(true)}>All tools</button>}>
    <div className="tool-overview"><div><strong>{short(totals.calls)}</strong><span>calls</span></div><div className="tool-count text-green"><b>{short(totals.success)}</b><span>succeeded</span></div><div className="tool-count text-red"><b>{short(totals.failed)}</b><span>failed</span></div><div className="tool-count text-cyan"><b>{fmt(inFlight ?? pending)}</b><span>{inFlight === null && pending !== null ? 'awaiting result' : 'in flight'}</span></div></div>
    {tools.length ? <><div className="tool-success"><span>Known outcomes</span><div className="bar-track"><span className="green" style={{ width: known ? `${totals.success / known * 100}%` : '0%' }} /></div><strong>{known ? `${Math.round(totals.success / known * 100)}%` : '—'}</strong></div><ToolTable tools={tools.slice(0, 3)} preview /></> : <p className="compact-empty">No tool calls observed.</p>}
    {details && <DetailDrawer title="Tool performance" onClose={() => setDetails(false)}><p className="card-footnote">{fmt(totals.calls)} calls · {fmt(totals.success)} succeeded · {fmt(totals.failed)} failed · {fmt(inFlight)} in flight · {fmt(totals.unknown)} without a known outcome. Success rate excludes unknown outcomes.</p><ToolTable tools={tools} /></DetailDrawer>}
  </Card>;
}
function TimingCard(props: { session: Session; now: number; observer?: ObserverSnapshot; onObserver: (value: ObserverSnapshot) => void; selectionError: string | null }) {
  return <Card title="Timing & progress" icon="clock" className="timing-card"><TimingPanel {...props} /></Card>;
}
function MetadataCard({ session, now = Date.now() }: { session: Session; now?: number }) {
  const { when, provenance } = useTimes();
  const view = runtimePresentation(session, now);
  return <Card title="Session details" icon="folder" className="metadata-card"><dl className="metadata-list"><div><dt>Provider</dt><dd><Icon name={session.provider} size={14} />{providerNames[session.provider]}</dd></div><div><dt>Model</dt><dd title={provenance(session.model)}>{session.model.value ?? 'Not reported'}</dd></div><div><dt>Effort</dt><dd title={provenance(session.effort)}>{session.effort.value ?? 'Not reported'}</dd></div><div><dt>Project</dt><dd title={session.project ?? undefined}>{session.project ?? 'Not reported'}</dd></div><div><dt>Session branch</dt><dd title={session.branch ?? undefined}><Icon name="branch" size={14} />{session.branch ?? 'Not reported'}</dd></div><div><dt>Workspace branch (current)</dt><dd title={session.workspaceBranch ? provenance(session.workspaceBranch) : undefined}>{session.workspaceBranch?.value ?? "Not reported"}{session.workspaceBranch?.provenance.quality === "stale" && <small className="text-amber">stale</small>}</dd></div><div><dt>Started</dt><dd>{when(session.startedAt)}</dd></div><div className="full-width"><dt>Working directory</dt><dd className="mono wrap-text">{session.cwd ?? 'Not reported'}</dd></div><div className="full-width"><dt>Native session ID</dt><dd className="mono wrap-text">{session.nativeId}</dd></div><div className="full-width"><dt>Source namespace</dt><dd className="mono wrap-text">{session.namespace}</dd></div>{session.forkedFromId && <div className="full-width"><dt>Forked from</dt><dd className="mono wrap-text">{session.forkedFromId}</dd></div>}</dl><div className="runtime-evidence"><span className={`status-dot ${view.verified ? 'green' : 'muted-fill'}`} /><span>{view.verified ? `Runtime reachable${session.runtime.loaded ? ' · thread loaded' : ''}${session.runtime.pid ? ` · PID ${session.runtime.pid}` : ''}` : `Runtime unverified · ${session.collection?.condition ?? 'native source unconfirmed'}`}<small>{session.runtime.attachment === 'known' ? 'Terminal attachment known' : 'Terminal attachment unknown'}</small></span></div></Card>;
}
export function SubagentRow({ session, now, diagnostics = [] }: { session: Session; now: number; diagnostics?: Diagnostic[] }) {
  const { when } = useTimes();
  const view = runtimePresentation(session, now, diagnostics);
  const at = reportedActivityAt(session);
  const role = session.agentRole === 'approval-reviewer' ? 'Approval reviewer' : session.agentRole === 'implementation' ? 'Implementation agent' : 'Role not reported';
  return <li><span className={`provider-mark ${session.provider}`}><Icon name={session.provider} size={15} /></span><div className="subagent-content"><strong title={session.name}>{session.name}</strong><span>{role} · {session.model.value ?? session.nativeId.slice(0, 12)}</span>{session.task?.objective && <p className="subagent-objective">{session.task.objective}</p>}<div className="subagent-state"><Status session={session} small now={now} diagnostics={diagnostics} /><small>{view.verified ? 'Native runtime confirmed' : 'Runtime unverified'} · Collection {session.collection?.condition ?? 'not reported'}</small></div><div className="subagent-last-activity"><span>Last activity</span>{at ? <><time dateTime={at} title={when(at, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}>{when(at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span>{relative(at, now)}</span></> : <span className="missing-activity-time">No timestamp reported<small>The native source has no valid activity timestamp.</small></span>}</div><small className="subagent-condition">{view.condition}</small></div><div className="subagent-tokens"><strong>{short(session.usage.value?.total)}</strong><span>tokens</span></div></li>;
}
export function SubagentsCard({ session, children, now = Date.now(), diagnostics = [] }: { session: Session; children: Session[]; now?: number; diagnostics?: Diagnostic[] }) {
  const [details, setDetails] = useState(false);
  const active = children.filter(child => sessionEligibility(child, now).lifecycle === 'open').sort((a, b) => compareTimestamps(b.lastActivityAt, a.lastActivityAt));
  const fullChildren = session.aggregates?.children?.total ?? null;
  const total = fullChildren ?? session.aggregates?.observedChildren?.total ?? null;
  const childSubtotal = fullChildren === null && total !== null;
  const main = session.aggregates?.main?.total ?? session.usage.value?.total ?? null;
  const fullInclusive = session.aggregates?.inclusive?.total ?? null;
  const inclusive = fullInclusive ?? session.aggregates?.observedInclusive?.total ?? null;
  const inclusiveSubtotal = fullInclusive === null && inclusive !== null;
  const knownChildren = session.aggregates?.knownChildren;
  const childCount = session.aggregates?.childCount ?? children.length;
  return <Card title="Subagents" icon="agents" className="subagents-card" action={<button className="detail-link" onClick={() => setDetails(true)}>All {childCount}</button>}>
    <div className="subagent-summary"><strong>{active.length}</strong><span>active / recorded open</span><span className="text-purple">{short(total)} tokens{childSubtotal ? ' · partial' : ''}</span></div>
    {active.length ? <ul className="subagent-preview">{active.slice(0, 2).map(child => {
      const progress = child.task?.items.filter(item => item.kind === 'progress' || item.kind === 'summary').at(-1)?.text;
      return <li key={child.id}><div><strong>{brief(child.name, 48)}</strong><Status session={child} small now={now} diagnostics={diagnostics} /></div><p>{brief(progress ?? child.task?.objective ?? child.latestActivity)}</p>{child.agentRole === 'approval-reviewer' && <small>Approval reviewer</small>}</li>;
    })}</ul> : <p className="compact-empty">No active subagent work reported.</p>}
    {active.length > 2 && <button className="detail-link" onClick={() => setDetails(true)}>View {active.length - 2} more active subagents</button>}
    {details && <DetailDrawer title="Subagents & usage" onClose={() => setDetails(false)}><div className="usage-scope-totals"><div><span>Main agent</span><strong>{fmt(main)}</strong></div><div><span>{childSubtotal ? 'Observed child subtotal' : 'Children'}</span><strong>{fmt(total)}</strong></div><div><span>{inclusiveSubtotal ? 'Observed inclusive subtotal' : 'Inclusive'}</span><strong>{fmt(inclusive)}</strong></div></div><p className="card-footnote">{knownChildren === undefined ? 'Child usage coverage not reported.' : `${knownChildren} of ${childCount} child usage contributions reported.`}{session.aggregates?.partial ? ' Totals include only reported contributions.' : ''}</p><ul className="subagent-list">{[...children].sort((a, b) => Number(sessionEligibility(b, now).lifecycle === 'open') - Number(sessionEligibility(a, now).lifecycle === 'open') || compareTimestamps(b.lastActivityAt, a.lastActivityAt)).map(child => <SubagentRow key={child.id} session={child} now={now} diagnostics={diagnostics} />)}</ul></DetailDrawer>}
  </Card>;
}

function AttributionCard({ session }: { session: Session }) {
  const { provenance } = useTimes();
  const [details, setDetails] = useState(false);
  const edits = session.edits.value;
  return <Card title="Observed changes" icon="file" className="edits-card" action={<button className="detail-link" onClick={() => setDetails(true)}>Details</button>}><div className="edit-metrics"><div><strong>{fmt(edits?.files)}</strong><span>attributable files</span></div><div><b className="text-green">{isKnown(edits?.additions) ? `+${fmt(edits?.additions)}` : '—'}</b><span>additions</span></div><div><b className="text-red">{isKnown(edits?.deletions) ? `−${fmt(edits?.deletions)}` : '—'}</b><span>deletions</span></div></div>{details && <DetailDrawer title="Observed changes & cost" onClose={() => setDetails(false)}><p className="card-footnote">{session.edits.provenance.reason ?? 'Edits observed in this session’s native tool records. Shared workspace changes may have other authors.'}</p><div className="cost-block"><span>API-equivalent priced subtotal</span><strong>{session.cost.value ? `$${session.cost.value.usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}` : 'Unavailable'}</strong><p>{session.cost.value?.label ?? session.cost.provenance.reason ?? 'Complete usage categories and known model pricing are required.'}</p><small>Not a subscription invoice</small>{session.costCoverage && <p className="pricing-coverage">Priced {fmt(session.costCoverage.pricedTokens)} of {fmt(session.costCoverage.observedTokens)} observed tokens. {session.costCoverage.reason}<br />Pricing registry: {session.costCoverage.registryDate}</p>}</div><p className="source-detail">{provenance(session.edits)}</p></DetailDrawer>}</Card>;
}
export function RecentActivity({ session, now = Date.now() }: { session: Session; now?: number }) {
  const { when } = useTimes();
  const activities = chronologicalActivities(session.activities).slice(0, 12);
  return <Card title="Recent activity" icon="pulse" className="recent-card" action={<span className="muted small-copy">Newest first</span>}>{activities.length ? <ol className="activity-list" aria-label="Activity timeline, newest first">{activities.map((a, i) => {
    const at = a.occurredAt ?? a.at;
    const valid = epochMilliseconds(at) !== null;
    return <li key={`${a.id}-${i}`} data-activity-id={a.id}><span className={`activity-symbol ${a.outcome === 'failure' ? 'text-red' : a.outcome === 'success' ? 'text-green' : a.kind === 'usage' ? 'text-cyan' : 'text-purple'}`}><Icon name={a.kind === 'tool' ? 'tool' : a.kind === 'edit' ? 'file' : a.kind === 'usage' ? 'tokens' : a.kind === 'turn' ? 'check' : 'pulse'} size={15} /></span><div className="activity-description"><strong>{a.label}</strong>{a.detail && <p>{a.detail}</p>}</div><div className="activity-timestamp"><time dateTime={valid ? at : undefined} title={`Occurred ${when(at, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}${a.ingestedAt ? `\nIngested ${when(a.ingestedAt)}` : ''}`}>{valid ? when(at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'No timestamp reported'}</time>{valid && <span>{relative(at, now)}</span>}</div></li>;
  })}</ol> : <Empty compact icon="pulse" title="Waiting for observable activity" detail="Metadata and metrics will update automatically as native sources change." />}</Card>;
}
export function SessionSummary({ session, now = Date.now(), diagnostics = [] }: { session: Session; now?: number; diagnostics?: Diagnostic[] }) {
  const { when } = useTimes();
  const view = runtimePresentation(session, now, diagnostics);
  const at = reportedActivityAt(session);
  return <section className={`session-summary summary-${view.tone}`} aria-label="Session summary"><span className="summary-icon"><Icon name={view.verified && session.state.value === 'complete' ? 'check' : 'pulse'} size={25} /></span><div><span className="summary-label">Session summary</span><h2>{session.latestActivity && !/^unknown$/i.test(session.latestActivity) ? session.latestActivity : view.label}</h2><p>{view.detail} {session.timing.completedTurns ? `${session.timing.completedTurns} completed turn${session.timing.completedTurns === 1 ? '' : 's'} observed.` : ''}</p></div><div className="summary-state"><Status session={session} now={now} diagnostics={diagnostics} /><span title={when(at, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}>{at ? `${when(at)} · ${relative(at, now)}` : 'No timestamp reported'}</span></div></section>;
}
function readSelection() { try { return localStorage.getItem(SELECTION_KEY); } catch { return null; } }
function useMonitor() {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useRef({ revision: -1, observedAt: 0, instanceId: '' });
  useEffect(() => {
    let active = true;
    let refreshing: Promise<void> | null = null;
    let stream: EventSource | null = null;
    let streamAuthorization = browserAuthorizationRevision();
    let retryTimer: number | undefined;
    let refreshController: AbortController | null = null;
    const retiredInstances = new Set<string>();
    let receivedSequence = 0;
    let lastStreamAt = Date.now();
    const receive = (incoming: Snapshot) => {
      if (!active || !incoming || !Array.isArray(incoming.sessions) || typeof incoming.revision !== 'number') return;
      const observedAt = epochMilliseconds(incoming.observedAt) || 0;
      const instanceId = incoming.instanceId || '';
      if (retiredInstances.has(instanceId)) return;
      if (instanceId === latest.current.instanceId) {
        if (incoming.revision < latest.current.revision) return;
      } else if (latest.current.instanceId) retiredInstances.add(latest.current.instanceId);
      latest.current = { revision: incoming.revision, observedAt, instanceId };
      setSnapshot(incoming); setFailure(null);
    };
    const refresh = (): Promise<void> => {
      if (refreshing) return refreshing;
      const controller = new AbortController(); refreshController = controller;
      const sequenceAtStart = receivedSequence;
      refreshing = (async () => {
        try {
          const response = await localFetch('/api/snapshot', { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error(`Dashboard snapshot returned ${response.status}`);
          const incoming = await response.json() as Snapshot;
          // A stream may have crossed a restart while this request was pending.
          if (receivedSequence === sequenceAtStart || incoming.instanceId === latest.current.instanceId) receive(incoming);
          if (active && stream && streamAuthorization !== browserAuthorizationRevision()) connectStream();
        } catch (error) { if (active) setFailure(error instanceof Error ? error.message : 'The local dashboard is unavailable.'); }
        finally { refreshing = null; if (refreshController === controller) refreshController = null; }
      })();
      return refreshing;
    };
    function connectStream() {
      if (!active) return;
      window.clearTimeout(retryTimer);
      stream?.close();
      streamAuthorization = browserAuthorizationRevision();
      const current = new EventSource('/api/events');
      stream = current;
      lastStreamAt = Date.now();
      current.addEventListener('open', () => { if (active && current === stream) { setConnection('live'); void refresh(); } });
      current.addEventListener('snapshot', event => {
        if (!active || current !== stream) return;
        try { receivedSequence++; lastStreamAt = Date.now(); receive(JSON.parse((event as MessageEvent<string>).data) as Snapshot); setConnection('live'); }
        catch { void refresh(); }
      });
      current.addEventListener('heartbeat', () => { if (active && current === stream) lastStreamAt = Date.now(); });
      current.addEventListener('resync', () => { if (current === stream) void refresh(); });
      current.addEventListener('error', () => {
        if (!active || current !== stream) return;
        setConnection('reconnecting'); current.close();
        // Recreate fatal HTTP-401 streams after the snapshot path has refreshed the
        // HttpOnly cookie. Only one EventSource remains active for the application.
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => { void refresh().finally(() => { if (active && current === stream) connectStream(); }); }, 1500);
      });
    }
    void refresh(); connectStream();
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastStreamAt > 45000) { setConnection('reconnecting'); connectStream(); }
      void refresh();
    }, 30000);
    return () => { active = false; refreshController?.abort(); stream?.close(); window.clearTimeout(retryTimer); window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);
  const updateObserver = (observer: ObserverSnapshot) => setSnapshot(value => ({ ...value, observer }));
  return { snapshot, connection, failure, updateObserver };
}
function HistoryPanel({ sessions, filters, onFilters, selectedId, select, onClose, now }: { sessions: Session[]; filters: SessionFilters; onFilters: (value: SessionFilters) => void; selectedId: string | null; select: (id: string) => void; onClose: () => void; now: number }) {
  return <aside className="history-panel" aria-label="Session history"><p className="history-result-count" role="status">{sessions.length} matching conversation{sessions.length === 1 ? '' : 's'}</p><div className="history-controls"><label className="search-field"><Icon name="search" size={17} /><input autoFocus type="search" placeholder="Search name, project, or ID" value={filters.query} onChange={event => onFilters({ ...filters, query: event.target.value })} aria-label="Search session history" /></label><select value={filters.provider} onChange={event => onFilters({ ...filters, provider: event.target.value as SessionFilters['provider'] })} aria-label="Filter session provider"><option value="all">All providers</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select></div><label className="history-toggle"><input type="checkbox" checked={filters.showHistory} onChange={event => onFilters({ ...filters, showHistory: event.target.checked })} />Show historical and archived sessions</label><div className="history-list">{sessions.length ? sessions.map(session => <button key={session.id} className={`history-item${session.id === selectedId ? ' selected' : ''}`} onClick={() => { select(session.id); onClose(); }}><span className={`provider-mark ${session.provider}`}><Icon name={session.provider} /></span><span className="history-item-content"><strong>{session.name}</strong><span>{session.project ?? session.cwd ?? session.nativeId}</span><small>{providerNames[session.provider]} · {relative(reportedActivityAt(session), now)}{session.archived ? ' · archived' : ''}</small></span><Status session={session} small now={now} /></button>) : <Empty compact icon="search" title={filters.showHistory || filters.query ? 'No matching sessions' : 'No open or confirmed sessions'} detail={filters.showHistory || filters.query ? 'Try a different name, path, or provider.' : 'Historical sessions are hidden. Enable the checkbox above to browse them.'} />}</div></aside>;
}
export default function App() {
  const { snapshot, connection, failure, updateObserver } = useMonitor();
  const [selectedId, setSelectedId] = useState<string | null>(readSelection);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessionDetail, setSessionDetail] = useState<'metadata' | 'activity' | null>(null);
  const [sessionFilters, setSessionFilters] = useState<SessionFilters>({ query: '', provider: 'all', showHistory: false });
  const [now, setNow] = useState(Date.now());
  const [tabLimit, setTabLimit] = useState(12);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const mainSessions = useMemo(() => snapshot.sessions.filter(s => !s.parentId), [snapshot.sessions]);
  const selected = snapshot.sessions.find(s => s.id === selectedId);
  const listedSessions = useMemo(() => filteredSessionCollection(mainSessions, sessionFilters, now), [mainSessions, sessionFilters, now]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const fitTabs = () => setTabLimit(Math.max(6, Math.min(18, Math.floor(Math.max(180, window.innerWidth - 60) / 180) * 2)));
    fitTabs(); window.addEventListener('resize', fitTabs);
    return () => window.removeEventListener('resize', fitTabs);
  }, []);
  useEffect(() => {
    // During initial backfill, retain a saved selection until its source is enumerated.
    if (!selected && mainSessions.length && (!selectedId || !snapshot.collecting)) setSelectedId(defaultSelection(mainSessions, now));
  }, [mainSessions, selected, selectedId, snapshot.collecting, now]);
  useEffect(() => { if (selectedId) { try { localStorage.setItem(SELECTION_KEY, selectedId); } catch { /* Storage may be disabled by browser policy. */ } } }, [selectedId]);
  useEffect(() => { document.title = selected ? selected.name : 'Agent Monitor'; }, [selected?.name]);
  const observerReady = Boolean(snapshot.observer);
  const selectableSessionId = selected && !snapshot.collecting ? selected.id : null;
  useEffect(() => {
    if (!selectableSessionId || !observerReady) return;
    let active = true;
    let retryTimer: number | undefined;
    let failures = 0;
    setSelectionError(null);
    const select = async () => {
      try {
        const value = await observerRequest('selection', { sessionId: selectableSessionId });
        if (active) { setSelectionError(null); updateObserver(value); }
      } catch (error) {
        if (!active) return;
        const message = error instanceof Error ? error.message : 'Observer selection failed.';
        failures++;
        setSelectionError(`${message}${failures <= 3 ? ' Retrying selection automatically.' : ''}`);
        if (failures <= 3) retryTimer = window.setTimeout(() => { void select(); }, 1500 * 2 ** (failures - 1));
      }
    };
    void select();
    return () => { active = false; window.clearTimeout(retryTimer); };
    // Wait for a collected identity, retry transient startup failures, and cancel
    // obsolete retries on tab switches or server replacement.
  }, [selectableSessionId, observerReady, snapshot.instanceId]);
  useEffect(() => {
    if (selectedId && snapshot.observer?.selectedSessionId === selectedId) setSelectionError(null);
  }, [selectedId, snapshot.observer?.selectedSessionId]);
  useEffect(() => { const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { setHistoryOpen(false); } }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, []);
  useEffect(() => { setSessionDetail(null); }, [selectedId]);
  const tabs = limitSessionTabs(sessionTabs(mainSessions, selectedId, now), selectedId, tabLimit);
  const children = selected ? snapshot.sessions.filter(s => s.parentId === selected.id || (s.parentId === selected.nativeId && s.namespace === selected.namespace && s.provider === selected.provider)) : [];
  const allowances = selected ? snapshot.allowances.filter(a => selected.allowanceIds.includes(a.id)) : [];
  const liveCount = listedSessions.filter(session => sessionEligibility(session, now).runtimeConfirmed).length;
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextTabIndex(event.key, index, tabs.length);
    if (next !== null) { event.preventDefault(); setSelectedId(tabs[next].id); tabRefs.current.get(tabs[next].id)?.focus(); }
  };
  return <DisplayZone.Provider value={snapshot.observer?.settings.timezone ?? null}><div className="app-shell"><a className="skip-link" href="#session-dashboard">Skip to dashboard</a><div className="topbar"><a href="/" className="brand" aria-label="Agent Monitor home"><span className="brand-symbol"><Icon name="pulse" size={22} /></span><span>Agent Monitor</span><span className="local-label">Local</span></a><div className="topbar-actions"><span className={`connection ${connection}`} role="status"><span className="status-dot" />{connection === 'live' ? 'Stream connected' : connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</span><button className={`text-button${historyOpen ? ' active' : ''}`} onClick={() => { setHistoryOpen(v => !v); }} aria-expanded={historyOpen}><Icon name="history" size={17} /><span>History</span><span className="button-count">{listedSessions.length}</span></button></div></div>
    {failure && <div className="connection-banner" role="alert"><Icon name="info" />{failure}. Showing the last available snapshot while reconnecting.</div>}
    {connection === 'reconnecting' && !failure && <div className="connection-banner" role="status"><Icon name="info" />Reconnecting to the local observer. Your selection and last snapshot are preserved.</div>}
    {selected ? <header className="session-header"><div className={`session-avatar ${selected.provider}`}><Icon name={selected.provider} size={28} /></div><div className="session-heading"><div className="session-heading-top"><span>{providerNames[selected.provider]}</span><span className="separator">/</span><span>{selected.model.value ?? 'Model not reported'}</span>{selected.effort.value && <span className="effort-label">{selected.effort.value}</span>}</div><h1 title={selected.name}>{selected.name}</h1><p><Icon name="folder" size={14} /><span title={selected.cwd ?? undefined}>{selected.project ?? selected.cwd ?? 'Working directory not reported'}</span></p></div><div className="header-status"><Status session={selected} now={now} diagnostics={snapshot.diagnostics} /><div className="header-detail-actions"><button className="detail-link" onClick={() => setSessionDetail('metadata')}>Session details</button><button className="detail-link" onClick={() => setSessionDetail('activity')}>Activity</button></div></div></header> : <header className="waiting-header"><h1>Your agents, in view.</h1><p>Existing Codex and Claude Code sessions appear automatically as local sources are discovered.</p></header>}
    {tabs.length > 0 && <nav className="sessions-nav" aria-label="Session navigation"><div className="sessions-tabs" role="tablist" aria-label="Sessions">{tabs.map((s, i) => <button key={s.id} id={`tab-${encodeURIComponent(s.id)}`} role="tab" aria-selected={s.id === selectedId} aria-controls="session-dashboard" tabIndex={s.id === selectedId ? 0 : -1} ref={element => { if (element) tabRefs.current.set(s.id, element); else tabRefs.current.delete(s.id); }} onKeyDown={event => onTabKey(event, i)} onClick={() => setSelectedId(s.id)} className={`session-tab ${s.provider}${s.id === selectedId ? ' selected' : ''}`} title={`${s.name}\n${providerNames[s.provider]} · ${runtimePresentation(s, now, snapshot.diagnostics).label}\n${s.nativeId}`}><Icon name={s.provider} size={16} /><span>{s.name}</span><span className={`tab-state state-${runtimePresentation(s, now, snapshot.diagnostics).tone}`} /></button>)}</div>{mainSessions.length > tabs.length && <button className="all-sessions" onClick={() => { setHistoryOpen(true); }} aria-label={`Browse ${listedSessions.length} matching sessions`}>All sessions ({listedSessions.length})<Icon name="chevron" size={13} /></button>}</nav>}
    <div className="session-counts"><span><span className="status-dot green" />{liveCount} runtime{liveCount === 1 ? '' : 's'} confirmed<span className="counts-divider">·</span>{listedSessions.length - liveCount} with unconfirmed runtime</span><span>{snapshot.collector?.state === 'failed' ? 'Collection failed; retrying' : snapshot.collecting ? 'Discovering local sources…' : snapshot.collector?.state === 'degraded' ? 'Some sources unavailable' : 'Observing local sources'}<span className="counts-divider">·</span>{snapshot.observedAt ? `${snapshot.collector?.cached ? 'Cached snapshot' : 'Collector snapshot'} ${relative(snapshot.observedAt, now).toLowerCase()}` : 'First snapshot pending'}</span></div>
    {historyOpen && <DetailDrawer title="Session history" onClose={() => setHistoryOpen(false)}><HistoryPanel sessions={listedSessions} filters={sessionFilters} onFilters={setSessionFilters} selectedId={selectedId} select={setSelectedId} onClose={() => setHistoryOpen(false)} now={now} /></DetailDrawer>}
    <main id="session-dashboard" role={selected ? 'tabpanel' : undefined} aria-labelledby={selected ? `tab-${encodeURIComponent(selected.id)}` : undefined} tabIndex={-1}>{selected ? <div className="dashboard-columns" key={selected.id}>
      <div className="dashboard-column"><ContextCard session={selected} /><AllowanceCard session={selected} allowances={allowances} now={now} /><AttributionCard session={selected} /></div>
      <div className="dashboard-column"><TimingCard session={selected} now={now} observer={snapshot.observer} onObserver={updateObserver} selectionError={selectionError} /><SubagentsCard session={selected} children={children} now={now} diagnostics={snapshot.diagnostics} /></div>
      <div className="dashboard-column"><TokensCard session={selected} /><ToolsCard session={selected} /></div>
    </div> : <div className="waiting-dashboard"><div className="waiting-orbit"><Icon name="pulse" size={46} /></div><h2>{snapshot.collecting ? 'Discovering your sessions' : 'Waiting for your agents'}</h2><p>Launch Codex or Claude Code normally. Sessions already on this computer and sessions you start later appear here automatically.</p><div className="waiting-providers"><span><Icon name="codex" />Codex</span><span><Icon name="claude" />Claude Code</span></div></div>}</main>{selected && sessionDetail && <DetailDrawer title={sessionDetail === 'metadata' ? 'Session details' : 'Recent activity'} onClose={() => setSessionDetail(null)}>{sessionDetail === 'metadata' ? <MetadataCard session={selected} now={now} /> : <><RecentActivity session={selected} now={now} /><SessionSummary session={selected} now={now} diagnostics={snapshot.diagnostics} /></>}</DetailDrawer>}<footer><span><Icon name="shield" size={14} />Local session collection</span><span>Agent Monitor<span className="counts-divider">·</span>AI assessment {snapshot.observer?.settings.enabled ? "on" : "off"}</span></footer>
  </div></DisplayZone.Provider>;
}
