import { emptySession, emptyUsage, metric, sessionKey, type Allowance, type Session, type Usage } from '../../shared/types.js';
import type { RecordMeta } from '../../shared/adapter.js';

type Tool = { name: string; at: string; outcome: 'success' | 'failure' | 'unknown'; durationMs: number | null; origin?: 'raw' | 'typed'; turn?: string | null; edits?: { files: number; additions: number; deletions: number } };
export interface CodexState {
  nativeId: string; startedAt: string | null; lastAt: string | null; cwd: string | null; model: string | null; effort: string | null; branch: string | null;
  parent: string | null; fork: string | null; title: string | null; canonical: boolean; currentTurn: string | null;
  responses: Record<string, { usage: Usage; turn: string; at: string }>;
  modernTotal: Usage | null; legacyTotal: Usage | null; legacyInherited?: Usage | null; lastUsage: Usage | null; turnUsage: Usage | null;
  usageAt?: string | null; capacityAt?: string | null; turnUsageQuality?: 'reported' | 'derived';
  capacity: number | null; quota: { value: any; at: string } | null;
  tools: Record<string, Tool>; turnStarts: Record<string, string>; durations: Record<string, number>; completed: Record<string, true>;
  activities: Session['activities']; unknownTypes: Record<string, number>; checklist: { completed: number; total: number } | null;
  lastTask: string | null;
}
export const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export const string = (v: unknown): string | null => typeof v === 'string' && v.length ? v : null;
function identity(v: unknown): string | null { const s = string(v); return s && s.length <= 512 && s !== 'prototype' && !Object.hasOwn(Object.prototype,s) ? s : null; }
export function iso(v: unknown): string | null { const n = typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(n) ? new Date(n).toISOString() : null; }
export function usage(v: any): Usage | null {
  if (!v || typeof v !== 'object') return null;
  const u: Usage = { input: number(v.input_tokens ?? v.inputTokens ?? v.input), output: number(v.output_tokens ?? v.outputTokens ?? v.output), cachedInput: number(v.cached_input_tokens ?? v.cachedInputTokens ?? v.cachedInput), cacheCreation: number(v.cache_write_input_tokens ?? v.cacheWriteInputTokens ?? v.cacheCreation), reasoning: number(v.reasoning_output_tokens ?? v.reasoningOutputTokens ?? v.reasoning), total: number(v.total_tokens ?? v.totalTokens ?? v.total) };
  if (Object.values(u).every(x => x === null)) return null;
  if (u.total === null && u.input !== null && u.output !== null) u.total = u.input + u.output;
  return u;
}
export function sumUsage(values: Usage[]): Usage | null {
  if (!values.length) return null;
  const out = emptyUsage();
  for (const key of Object.keys(out) as (keyof Usage)[]) { const found = values.map(v => v[key]); out[key] = found.every(v => v !== null) ? found.reduce<number>((a, b) => a + (b ?? 0), 0) : null; }
  return out;
}
export function initialCodexState(nativeId: string): CodexState { return { nativeId, startedAt: null, lastAt: null, cwd: null, model: null, effort: null, branch: null, parent: null, fork: null, title: null, canonical: false, currentTurn: null, responses: {}, modernTotal: null, legacyTotal: null, lastUsage: null, turnUsage: null, capacity: null, quota: null, tools: {}, turnStarts: {}, durations: {}, completed: {}, activities: [], unknownTypes: {}, checklist: null, lastTask: null }; }
function activity(s: CodexState, id: string, at: string, kind: Session['activities'][number]['kind'], label: string, outcome?: Tool['outcome']) { const item = { id, at, kind, label, outcome }; const idx = s.activities.findIndex(a => a.id === id); if (idx >= 0) s.activities[idx] = item; else s.activities.push(item); s.activities = s.activities.slice(-80); }
function normalizeType(t: unknown): string { return typeof t === 'string' ? t.replace(/[_-]/g, '').toLowerCase() : ''; }
function duration(v: any): number | null { return number(v?.durationMs ?? v?.duration_ms) ?? (number(v?.duration?.secs) === null ? null : v.duration.secs * 1000 + (number(v.duration.nanos) ?? 0) / 1e6); }
function diffCount(text: unknown): { additions: number; deletions: number } { let additions = 0, deletions = 0; if (typeof text === 'string') for (const line of text.split('\n')) { if (line.startsWith('+') && !line.startsWith('+++')) additions++; if (line.startsWith('-') && !line.startsWith('---')) deletions++; } return { additions, deletions }; }
export function completedItem(s: CodexState, item: any, at: string, timing?: any): void {
  if (!item || typeof item !== 'object') return;
  const type = normalizeType(item.type); const id = identity(item.id ?? item.call_id ?? item.callId); if (!id) return;
  const toolNames: Record<string, string> = { commandexecution: 'Shell command', filechange: 'File edit', mcptoolcall: 'MCP tool', websearch: 'Web search', imageview: 'View image', collabagenttoolcall: 'Subagent', subagentactivity: 'Subagent', dynamictoolcall: 'Dynamic tool', imagegeneration: 'Image generation' };
  if (!Object.hasOwn(toolNames,type)) return;
  const prior = s.tools[id]; const status = normalizeType(item.status); const exit = number(item.exitCode ?? item.exit_code);
  const outcome: Tool['outcome'] = ['failed','error','declined','cancelled'].includes(status) || (typeof (item.exitCode ?? item.exit_code) === 'number' && exit !== 0) ? 'failure' : ['completed','success','succeeded'].includes(status) ? 'success' : prior?.outcome ?? 'unknown';
  const started = number(timing?.started_at_ms ?? item.startedAtMs); const ended = number(timing?.completed_at_ms ?? item.completedAtMs);
  const tool: Tool = { name: type === 'mcptoolcall' ? `${string(item.server) ?? 'MCP'} / ${string(item.tool) ?? 'tool'}` : toolNames[type], at, outcome, origin: 'typed', turn: timing?.turn_id ?? s.currentTurn, durationMs: duration(item) ?? (started !== null && ended !== null ? Math.max(0, ended - started) : prior?.durationMs ?? null) };
  if (type === 'filechange') { const changes = item.changes; const entries: any[] = Array.isArray(changes) ? changes : changes && typeof changes === 'object' ? Object.values(changes) : []; let additions = 0, deletions = 0; for (const e of entries) { const d = diffCount(e.diff ?? e.unified_diff ?? e.content); additions += d.additions; deletions += d.deletions; } tool.edits = { files: entries.length, additions, deletions }; }
  s.tools[id] = tool; activity(s, `tool:${id}`, at, type === 'filechange' ? 'edit' : 'tool', tool.name, outcome);
}
export function reduceCodex(s: CodexState, record: any, meta?: RecordMeta): void {
  if (!record || typeof record !== 'object') return;
  const p = record.payload ?? {}; const at = iso(record.timestamp) ?? s.lastAt ?? new Date(0).toISOString();
  const type = record.type; const nativeThread = string(p.thread_id ?? p.threadId);
  // Forks may carry copied ancestor records. Only their canonical session metadata establishes identity.
  if (type === 'session_meta') {
    const id = string(p.id ?? p.thread_id); if (id !== s.nativeId) return;
    if (!s.canonical) { s.canonical = true; s.startedAt = iso(p.timestamp) ?? at; }
    s.cwd = string(p.cwd) ?? s.cwd; s.model = string(p.model) ?? s.model; s.effort = string(p.reasoning_effort) ?? s.effort;
    const spawn = p.source?.subagent?.thread_spawn ?? p.source?.subAgent?.threadSpawn;
    s.parent = string(spawn?.parent_thread_id ?? spawn?.parentThreadId ?? p.parent_thread_id) ?? s.parent;
    s.fork = string(p.forked_from_id ?? p.forkedFromId) ?? s.fork; s.branch = string(p.git?.branch ?? p.git_info?.branch) ?? s.branch; return;
  }
  if (!s.canonical || (nativeThread && nativeThread !== s.nativeId)) return;
  if ((s.fork || s.parent) && at < (s.startedAt ?? at)) {
    if (type === 'event_msg' && p.type === 'token_count') s.legacyInherited = usage(p.info?.total_token_usage) ?? s.legacyInherited;
    return;
  }
  if (!s.lastAt || at > s.lastAt) s.lastAt = at;
  if (type === 'turn_context') { const turn = identity(p.turn_id); if (turn && turn !== s.currentTurn) s.turnUsage = null; s.currentTurn = turn ?? s.currentTurn; s.cwd = string(p.cwd) ?? s.cwd; s.model = string(p.model) ?? s.model; s.effort = string(p.effort ?? p.reasoning_effort ?? p.collaboration_mode?.settings?.reasoning_effort) ?? s.effort; return; }
  if (type === 'token_usage_record') {
    const u = usage(p.usage ?? p.response_usage); const response = identity(p.response_id ?? p.responseId); const turn = identity(p.turn_id) ?? s.currentTurn ?? '';
    if (u && response) s.responses[`${turn}:${response}`] = { usage: u, turn, at };
    s.modernTotal = usage(p.thread_token_usage ?? p.threadUsage) ?? s.modernTotal; s.lastUsage = u ?? s.lastUsage; if (u) s.usageAt = at;
    if (!s.currentTurn || turn === s.currentTurn) { const reportedTurn = usage(p.turn_token_usage); s.turnUsage = reportedTurn ?? sumUsage(Object.values(s.responses).filter(r => r.turn === turn).map(r => r.usage)); s.turnUsageQuality = reportedTurn ? 'reported' : 'derived'; }
    return;
  }
  if (type === 'event_msg') {
    const e = p.type;
    if (e === 'token_count') { s.legacyTotal = usage(p.info?.total_token_usage) ?? s.legacyTotal; s.lastUsage = usage(p.info?.last_token_usage) ?? s.lastUsage; s.usageAt = at; const capacity = number(p.info?.model_context_window); if (capacity !== null) { s.capacity = capacity; s.capacityAt = at; } if (p.rate_limits) s.quota = { value: p.rate_limits, at }; return; }
    if (e === 'item_completed') { completedItem(s, p.item, at, p); return; }
    if (e === 'task_started' || e === 'turn_started') { const turn = identity(p.turn_id) ?? s.currentTurn ?? `offset:${meta?.offset ?? at}`; s.currentTurn = turn; s.turnStarts[turn] = at; s.turnUsage = null; s.lastTask = 'started'; const capacity = number(p.model_context_window); if (capacity !== null) { s.capacity = capacity; s.capacityAt = at; } activity(s, `start:${turn}`, at, 'turn', 'Turn started'); return; }
    if (e === 'task_complete' || e === 'task_completed' || e === 'turn_complete' || e === 'turn_completed' || e === 'turn_aborted') { const turn = identity(p.turn_id) ?? s.currentTurn ?? at; s.completed[turn] = true; const start = s.turnStarts[turn]; const d = number(p.duration_ms) ?? (start ? Math.max(0, Date.parse(at) - Date.parse(start)) : null); if (d !== null) s.durations[turn] = d; s.lastTask = e === 'turn_aborted' ? 'aborted' : 'complete'; activity(s, `done:${turn}`, at, 'turn', e === 'turn_aborted' ? 'Turn stopped' : 'Turn completed'); return; }
    if (e === 'thread_name_updated' && string(p.name)) { s.title = p.name; return; }
    if (e === 'context_compacted') { s.lastUsage = null; activity(s, `compact:${meta?.offset ?? at}`, at, 'compaction', 'Context compacted'); return; }
    // Presentation prose, prompts, and reasoning are deliberately not retained.
    if (['agent_message','agent_reasoning','user_message','thread_settings_applied','agent_reasoning_section_break','agent_reasoning_raw_content','mcp_startup_update','mcp_startup_complete'].includes(e)) return;
  }
  if (type === 'response_item') {
    const id = identity(p.call_id ?? p.id); const t = p.type;
    if (['function_call','custom_tool_call','local_shell_call','web_search_call'].includes(t) && id) {
      const toolName = string(p.name);
      // Completed typed items use the same native call identity and replace this provisional observation.
      if (!s.tools[id]) s.tools[id] = { name: toolName ?? (t === 'web_search_call' ? 'Web search' : 'Tool call'), at, outcome: 'unknown', origin: 'raw', turn: s.currentTurn, durationMs: null };
      if ((toolName === 'update_plan' || toolName?.endsWith('__update_plan')) && typeof p.arguments === 'string') { try { const args = JSON.parse(p.arguments); if (Array.isArray(args?.plan) && args.plan.length) s.checklist = { total: args.plan.length, completed: args.plan.filter((x: any) => x?.status === 'completed').length }; } catch { /* Incomplete tool arguments carry no progress evidence. */ } }
      return;
    }
    if (['function_call_output','custom_tool_call_output'].includes(t) && id) {
      let result: any = p.output; if (typeof result === 'string' && result.startsWith('{')) { try { result = JSON.parse(result); } catch { result = null; } }
      const exit = typeof result?.exit_code === 'number' ? result.exit_code : typeof result?.exitCode === 'number' ? result.exitCode : null;
      const tool = s.tools[id]; if (tool && tool.outcome === 'unknown' && exit !== null) tool.outcome = exit === 0 ? 'success' : 'failure'; return;
    }
    return;
  }
  if (type === 'compacted') { s.lastUsage = null; activity(s, `compact:${meta?.offset ?? at}`, at, 'compaction', 'Context compacted'); return; }
  if (['world_state','agent_metadata'].includes(type)) return;
  // Unknown family names themselves are untrusted and may contain secrets or dangerous map keys.
  const unknown = type === 'event_msg' ? 'unrecognized_event' : 'unrecognized_record'; s.unknownTypes[unknown] = (s.unknownTypes[unknown] ?? 0) + 1;
}

export function quotaFromSnapshot(value: any, namespace: string, source: string, at: string, now: string): Allowance[] {
  if (!value || typeof value !== 'object') return [];
  const limit = string(value.limit_id ?? value.limitId) ?? 'default'; const out: Allowance[] = [];
  for (const bucket of ['primary','secondary']) { const w = value[bucket]; const used = number(w?.used_percent ?? w?.usedPercent); if (used === null || used > 100) continue;
    const resetsAt = iso(w.resets_at ?? w.resetsAt); const duration = number(w.window_minutes ?? w.windowDurationMins);
    const stale = Date.parse(now) - Date.parse(at) > 5 * 60_000 || (resetsAt !== null && Date.parse(resetsAt) <= Date.parse(now));
    out.push({ id: `codex:${namespace}:${limit}:${bucket}`, accountKey: `codex:${namespace}`, label: `${string(value.limit_name ?? value.limitName) ?? limit} · ${bucket}`, usedPercent: metric(used, source, 'account', stale ? 'stale' : 'reported', stale ? 'Snapshot is old; a past reset does not prove replenishment' : 'Shared account allowance, not a per-session allocation', at), windowMinutes: duration, resetsAt });
  }
  return out;
}
export function sessionFromState(s: CodexState, namespace: string, source: string, now: string): Session {
  const out = emptySession('codex', namespace, s.nativeId, source, now); const observedAt = s.lastAt ?? s.startedAt ?? now;
  out.startedAt = s.startedAt; out.lastActivityAt = s.lastAt; out.cwd = s.cwd; out.project = s.cwd?.replace(/\\/g,'/').replace(/\/$/,'').split('/').pop() ?? null; out.branch = s.branch;
  if (s.lastAt && Date.parse(now) - Date.parse(s.lastAt) < 15 * 60_000) out.state = metric('unknown',source,'runtime','derived','Recently active transcript; runtime and attachment are unconfirmed',observedAt);
  if (s.title) { out.name = s.title; out.nameSource = 'native title metadata'; }
  out.model = metric(s.model, source, 'session', s.model ? 'reported' : 'unavailable', undefined, observedAt); out.effort = metric(s.effort, source, 'session', s.effort ? 'reported' : 'unavailable', undefined, observedAt);
  out.parentId = s.parent ? sessionKey('codex', namespace, s.parent) : null; out.forkedFromId = s.fork ? sessionKey('codex', namespace, s.fork) : null;
  const modern = Object.values(s.responses);
  let ownLegacy = s.legacyTotal;
  if (ownLegacy && s.legacyInherited) {
    ownLegacy = { ...ownLegacy };
    for (const key of Object.keys(ownLegacy) as (keyof Usage)[]) ownLegacy[key] = ownLegacy[key] !== null && s.legacyInherited[key] !== null ? Math.max(0,ownLegacy[key]! - s.legacyInherited[key]!) : null;
  }
  // Legacy fork baselines are usable only when inherited cumulative accounting is observable.
  const total = s.fork || s.parent ? sumUsage(modern.map(x => x.usage)) ?? (s.legacyInherited ? ownLegacy : null) : s.modernTotal ?? sumUsage(modern.map(x => x.usage)) ?? s.legacyTotal;
  const usageAt = s.usageAt ?? observedAt; const contextStale = Date.parse(now) - Date.parse(usageAt) > 5 * 60_000;
  const usageQuality = !total ? 'unavailable' : s.fork || s.parent || (!s.modernTotal && modern.length) ? 'derived' : 'reported';
  out.usage = metric(total, source, s.parent ? 'subagent' : 'session', usageQuality, total ? 'Cached input is part of input; reasoning is part of output. Modern and legacy totals are never added.' : 'No supported usage record with an unambiguous consumption scope', usageAt);
  out.turnUsage = metric(s.turnUsage, source, 'turn', s.turnUsage ? s.turnUsageQuality ?? 'reported' : 'unavailable', s.turnUsage ? undefined : 'Current turn has no reported usage', usageAt);
  out.context.capacity = metric(s.capacity, source, 'context', s.capacity ? 'reported' : 'unavailable', undefined, s.capacityAt ?? observedAt);
  out.context.used = metric(s.lastUsage?.total ?? null, source, 'context', s.lastUsage?.total !== null && s.lastUsage?.total !== undefined ? contextStale ? 'stale' : 'derived' : 'unavailable', 'Latest reported response footprint; pending input and compaction may change actual context', usageAt);
  out.latestActivity = s.activities.at(-1)?.label ?? 'Persisted session'; out.activities = s.activities;
  const grouped = new Map<string, Session['tools'][number]>();
  const allTools = Object.values(s.tools); const typedTurns = new Set(allTools.filter(x => x.origin === 'typed').map(x => x.turn));
  // Paginated history persists concrete tool items in addition to presentation-level raw calls.
  // Count its native typed invocations once; raw calls are a fallback for legacy-only turns.
  const countedTools = allTools.filter(t => t.origin !== 'raw' || !typedTurns.has(t.turn));
  for (const t of countedTools) { let g = grouped.get(t.name); if (!g) { g = { name: t.name, category: /shell|exec|command/i.test(t.name) ? 'execution' : /file|patch|edit/i.test(t.name) ? 'edits' : /agent|spawn/i.test(t.name) ? 'agents' : 'tools', calls: 0, succeeded: 0, failed: 0, unknown: 0, durationMs: null, retries: null }; grouped.set(t.name, g); } g.calls++; if (t.outcome === 'success') g.succeeded++; else if (t.outcome === 'failure') g.failed++; else g.unknown++; if (t.durationMs !== null) g.durationMs = (g.durationMs ?? 0) + t.durationMs; }
  out.tools = [...grouped.values()].sort((a,b) => b.calls - a.calls);
  const edits = Object.values(s.tools).flatMap(x => x.edits ? [x.edits] : []); if (edits.length) out.edits = metric({ files: edits.reduce((a,b) => a + b.files,0), additions: edits.reduce((a,b) => a + b.additions,0), deletions: edits.reduce((a,b) => a + b.deletions,0) }, source, 'session', 'derived', 'Observed file edit operations, not the shared workspace Git diff', observedAt);
  const trendResponses = modern.filter(x => x.usage.input !== null && x.usage.output !== null).slice(-120);
  out.trends = trendResponses.map((x,index) => ({ at: x.at, input: x.usage.input!, output: x.usage.output!, tools: countedTools.filter(t => t.at <= x.at && (index === 0 || t.at > trendResponses[index-1].at)).length }));
  const durations = Object.values(s.durations); out.timing.completedTurns = Object.keys(s.completed).length; out.timing.checklist = s.checklist;
  if (s.startedAt) out.timing.elapsedMs = metric(Math.max(0, Date.parse(s.lastAt ?? s.startedAt) - Date.parse(s.startedAt)), source, 'session', 'derived', 'Observed session span; not continuous active compute time', observedAt);
  out.timing.lastTurnMs = metric(durations.at(-1) ?? null, source, 'turn', durations.length ? 'reported' : 'unavailable', undefined, observedAt);
  out.timing.averageTurnMs = metric(durations.length ? durations.reduce((a,b) => a+b,0)/durations.length : null, source, 'turn', durations.length ? 'derived' : 'unavailable', undefined, observedAt);
  const unknown = Object.keys(s.unknownTypes); if (unknown.length) out.diagnostics.push({ provider: 'codex', namespace, level: 'info', code: 'codex-record-coverage', message: `Unrecognized record families skipped: ${unknown.slice(0,8).join(', ')}`, at: now });
  return out;
}
