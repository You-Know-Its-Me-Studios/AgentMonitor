import { emptySession, emptyUsage, metric, sessionKey, type Allowance, type Session, type Usage } from '../../shared/types.js';
import type { RecordMeta } from '../../shared/adapter.js';
import { normalizeTimestamp } from '../../shared/time.js';
import { evidenceText, genuineUserText, initialTaskEvidence, isObserverWorkspace, observeTaskEvidence, outputEvidence, taskEvidence, type TaskEvidenceState } from '../../server/task-evidence.js';

type Tool = { name: string; at: string; outcome: 'success' | 'failure' | 'unknown'; durationMs: number | null; origin?: 'raw' | 'typed'; turn?: string | null; endedAt?:string|null; phase?:'pending'|'in-flight'|'finished'|'interrupted'; wrapper?:boolean; edits?: { files: number; additions: number; deletions: number } };
export interface CodexState {
  nativeId: string; startedAt: string | null; lastAt: string | null; cwd: string | null; model: string | null; effort: string | null; branch: string | null;
  parent: string | null; fork: string | null; title: string | null; canonical: boolean; currentTurn: string | null;
  responses: Record<string, { usage: Usage; turn: string; at: string; model?:string|null; serviceTier?:string|null }>;
  modernTotal: Usage | null; legacyTotal: Usage | null; legacyInherited?: Usage | null; lastUsage: Usage | null; turnUsage: Usage | null;
  usageAt?: string | null; capacityAt?: string | null; turnUsageQuality?: 'reported' | 'derived';
  capacity: number | null; quota: { value: any; at: string } | null;
  tools: Record<string, Tool>; turnStarts: Record<string, string>; durations: Record<string, number>; completed: Record<string, true>;
  activities: Session['activities']; unknownTypes: Record<string, number>; checklist: { completed: number; total: number } | null;
  lastTask: string | null;
  taskEvidence?:TaskEvidenceState; historyStartOrdinal?:number|null; agentRole?:Session['agentRole']; observer?:boolean;
  serviceTier?:string|null;
  modelAt?:string|null;effortAt?:string|null;cwdAt?:string|null;branchAt?:string|null;
  agentError?:{at:string;message:string|null};
}
export const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export const string = (v: unknown): string | null => typeof v === 'string' && v.length ? v : null;
function identity(v: unknown): string | null { const s = string(v); return s && s.length <= 512 && s !== 'prototype' && !Object.hasOwn(Object.prototype,s) ? s : null; }
export function iso(v: unknown): string | null { return normalizeTimestamp(v); }
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
export function initialCodexState(nativeId: string): CodexState { return { nativeId, startedAt: null, lastAt: null, cwd: null, model: null, effort: null, branch: null, parent: null, fork: null, title: null, canonical: false, currentTurn: null, responses: {}, modernTotal: null, legacyTotal: null, lastUsage: null, turnUsage: null, capacity: null, quota: null, tools: {}, turnStarts: {}, durations: {}, completed: {}, activities: [], unknownTypes: {}, checklist: null, lastTask: null,taskEvidence:initialTaskEvidence(nativeId),historyStartOrdinal:null,agentRole:'unknown',observer:false }; }
function activity(s: CodexState, id: string, at: string, kind: Session['activities'][number]['kind'], label: string, outcome?: Tool['outcome'],meta?:RecordMeta&{ingestedAt?:string},originalTimestamp?:string|number) { const previous=s.activities.find(a=>a.id===id);const item = { id, at, occurredAt:at,ingestedAt:previous?.ingestedAt??meta?.ingestedAt??new Date().toISOString(),originalTimestamp:typeof originalTimestamp==='string'||typeof originalTimestamp==='number'?originalTimestamp:undefined,kind, label, outcome }; const idx = s.activities.findIndex(a => a.id === id); if (idx >= 0) s.activities[idx] = item; else s.activities.push(item); s.activities.sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));s.activities = s.activities.slice(-80); }
function signal(s:CodexState,kind:Parameters<typeof observeTaskEvidence>[1]['kind'],text:unknown,at:string,id:string,meta?:RecordMeta&{ingestedAt?:string},status?:string,originalTimestamp?:string|number){s.taskEvidence??=initialTaskEvidence(s.nativeId);observeTaskEvidence(s.taskEvidence,{kind,text,source:meta?.source??'Codex rollout',occurredAt:at,ingestedAt:meta?.ingestedAt,nativeId:id,turnId:s.currentTurn,status,originalTimestamp});}
function contentText(value:unknown):string {if(typeof value==='string')return value;if(!Array.isArray(value))return'';return value.filter(part=>part&&typeof part==='object'&&['input_text','output_text','text'].includes(part.type)).map(part=>part.text??'').filter(text=>typeof text==='string').join('\n');}
function argumentsObject(value:unknown):any {if(value&&typeof value==='object')return value;if(typeof value==='string'&&value.length<=256000){try{return JSON.parse(value);}catch{return null;}}return null;}
function normalizeType(t: unknown): string { return typeof t === 'string' ? t.replace(/[_-]/g, '').toLowerCase() : ''; }
function duration(v: any): number | null { return number(v?.durationMs ?? v?.duration_ms) ?? (number(v?.duration?.secs) === null ? null : v.duration.secs * 1000 + (number(v.duration.nanos) ?? 0) / 1e6); }
function diffCount(text: unknown): { additions: number; deletions: number } { let additions = 0, deletions = 0; if (typeof text === 'string') for (const line of text.split('\n')) { if (line.startsWith('+') && !line.startsWith('+++')) additions++; if (line.startsWith('-') && !line.startsWith('---')) deletions++; } return { additions, deletions }; }
export function completedItem(s: CodexState, item: any, at: string, timing?: any,meta?:RecordMeta&{ingestedAt?:string}): void {
  if (!item || typeof item !== 'object') return;
  const type = normalizeType(item.type); const id = identity(item.id ?? item.call_id ?? item.callId); if (!id) return;
  if(type==='usermessage'){const text=genuineUserText(contentText(item.content));if(text)signal(s,'request',text,at,id,meta,'user-input',timing?.completed_at_ms??at);return;}
  if(type==='agentmessage'){const text=contentText(item.content);signal(s,item.phase==='final_answer'?'summary':'progress',text,at,id,meta,item.phase??'public-update',timing?.completed_at_ms??at);return;}
  const toolNames: Record<string, string> = { commandexecution: 'Shell command', filechange: 'File edit', mcptoolcall: 'MCP tool', websearch: 'Web search', imageview: 'View image', collabagenttoolcall: 'Subagent', subagentactivity: 'Subagent', dynamictoolcall: 'Dynamic tool', imagegeneration: 'Image generation' };
  if (!Object.hasOwn(toolNames,type)) return;
  const prior = s.tools[id]; const status = normalizeType(item.status); const exit = number(item.exitCode ?? item.exit_code);
  const interrupted=['cancelled','canceled','interrupted','aborted'].includes(status);
  const outcome: Tool['outcome'] = ['failed','error','declined'].includes(status) || (typeof (item.exitCode ?? item.exit_code) === 'number' && exit !== 0) ? 'failure' : ['completed','success','succeeded'].includes(status) ? 'success' : prior?.outcome ?? 'unknown';
  const started = number(timing?.started_at_ms ?? item.startedAtMs); const ended = number(timing?.completed_at_ms ?? item.completedAtMs);
  const tool: Tool = { name: type === 'mcptoolcall' ? `${string(item.server) ?? 'MCP'} / ${string(item.tool) ?? 'tool'}` : type==='subagentactivity'?`Subagent ${string(item.kind)??'activity'}`:type==='dynamictoolcall'?prior?.name??string(item.tool)??toolNames[type]:toolNames[type], at:prior?.at??iso(started)??at,endedAt:['completed','success','succeeded','failed','error','declined'].includes(status)?at:null,phase:interrupted?'interrupted':['inprogress','running'].includes(status)?'in-flight':['completed','success','succeeded','failed','error','declined'].includes(status)?'finished':prior?.phase??'pending', outcome, origin: 'typed', turn: timing?.turn_id ?? s.currentTurn, durationMs: duration(item) ?? (started !== null && ended !== null ? Math.max(0, ended - started) : prior?.durationMs ?? null) };
  if (type === 'filechange') { const changes = item.changes; const entries: any[] = Array.isArray(changes) ? changes : changes && typeof changes === 'object' ? Object.values(changes) : []; let additions = 0, deletions = 0; for (const e of entries) { const d = diffCount(e.diff ?? e.unified_diff ?? e.content); additions += d.additions; deletions += d.deletions; } tool.edits = { files: entries.length, additions, deletions }; }
  s.tools[id] = tool; activity(s, `tool:${id}`, at, type === 'filechange' ? 'edit' : 'tool', tool.name, outcome,meta,timing?.completed_at_ms??at);
  if(!s.agentError||at>=s.agentError.at)s.agentError={at,message:outcome==='failure'?`${tool.name} failed`:null};
  const description=type==='commandexecution'?`${tool.name}: ${evidenceText(item.command,700)}; ${status||'outcome not reported'}${exit!==null?`; exit ${exit}`:''}${tool.durationMs!==null?`; ${(tool.durationMs/1000).toFixed(2)}s`:''}`:type==='subagentactivity'?`${tool.name}; native child ${string(item.agent_thread_id)??'unreported'}; path ${string(item.agent_path)??'unreported'}`:`${tool.name}: ${status||'outcome not reported'}`;
  signal(s,type==='subagentactivity'?'subagent':'tool',description,at,id,meta,tool.phase,timing?.completed_at_ms??at);
  const summary=outputEvidence(item.aggregated_output??item.stdout??item.result);if(summary)signal(s,outcome==='failure'?'blocker':'result',summary,at,`${id}:result`,meta,outcome,timing?.completed_at_ms??at);
}
export function reduceCodex(s: CodexState, record: any, meta?: RecordMeta&{ingestedAt?:string}): void {
  if (!record || typeof record !== 'object') return;
  const p = record.payload ?? {}; const eventTime=p.type==='item_completed'?(p.completed_at_ms??record.timestamp):p.internal_chat_message_metadata_passthrough?.create_time??record.timestamp;const at = iso(eventTime) ?? iso(record.timestamp) ?? s.lastAt ?? new Date(0).toISOString();
  const type = record.type; const nativeThread = string(p.thread_id ?? p.threadId);
  // Forks may carry copied ancestor records. Only their canonical session metadata establishes identity.
  if (type === 'session_meta') {
    const id = string(p.id ?? p.thread_id); if (id !== s.nativeId) return;
    if (!s.canonical) { s.canonical = true; s.startedAt = iso(p.timestamp) ?? at; }
    s.cwd = string(p.cwd) ?? s.cwd; s.model = string(p.model) ?? s.model; s.effort = string(p.reasoning_effort) ?? s.effort;
    if(string(p.cwd))s.cwdAt=at;if(string(p.model))s.modelAt=at;if(string(p.reasoning_effort))s.effortAt=at;
    const spawn = p.source?.subagent?.thread_spawn ?? p.source?.subAgent?.threadSpawn;
    s.parent = string(spawn?.parent_thread_id ?? spawn?.parentThreadId ?? p.parent_thread_id) ?? s.parent;
    s.fork = string(p.forked_from_id ?? p.forkedFromId) ?? s.fork; s.branch = string(p.git?.branch ?? p.git_info?.branch) ?? s.branch;if(string(p.git?.branch??p.git_info?.branch))s.branchAt=at;s.historyStartOrdinal=number(p.subagent_history_start_ordinal)??s.historyStartOrdinal;s.agentRole=p.thread_source==='guardian_review'||p.source?.subagent?.other==='guardian'?'approval-reviewer':s.parent?'implementation':'unknown';s.observer=isObserverWorkspace(p.cwd);return;
  }
  if (!s.canonical || (nativeThread && nativeThread !== s.nativeId)) return;
  if (((s.fork || s.parent) && at < (s.startedAt ?? at)) || (s.historyStartOrdinal!==null&&s.historyStartOrdinal!==undefined&&number(record.ordinal)!==null&&record.ordinal<s.historyStartOrdinal)) {
    if (type === 'event_msg' && p.type === 'token_count') s.legacyInherited = usage(p.info?.total_token_usage) ?? s.legacyInherited;
    return;
  }
  if (!s.lastAt || at > s.lastAt) s.lastAt = at;
  if(s.observer)return;
  if (type === 'turn_context') { const turn = identity(p.turn_id); if (turn && turn !== s.currentTurn) s.turnUsage = null; s.currentTurn = turn ?? s.currentTurn; s.cwd = string(p.cwd) ?? s.cwd; s.model = string(p.model) ?? s.model; s.effort = string(p.effort ?? p.reasoning_effort ?? p.collaboration_mode?.settings?.reasoning_effort) ?? s.effort;if(string(p.cwd))s.cwdAt=at;if(string(p.model))s.modelAt=at;if(string(p.effort??p.reasoning_effort??p.collaboration_mode?.settings?.reasoning_effort))s.effortAt=at;return; }
  if (type === 'token_usage_record') {
    const u = usage(p.usage ?? p.response_usage); const response = identity(p.response_id ?? p.responseId); const turn = identity(p.turn_id) ?? s.currentTurn ?? '';
    if(!s.currentTurn&&turn)s.currentTurn=turn;
    if (u && response) s.responses[`${turn}:${response}`] = { usage: u, turn, at,model:string(p.model)??s.model,serviceTier:string(p.service_tier??p.serviceTier)??s.serviceTier??null };
    s.modernTotal = usage(p.thread_token_usage ?? p.threadUsage) ?? s.modernTotal; s.lastUsage = u ?? s.lastUsage; if (u) s.usageAt = at;
    if (!s.currentTurn || turn === s.currentTurn) { const reportedTurn = usage(p.turn_token_usage); s.turnUsage = reportedTurn ?? sumUsage(Object.values(s.responses).filter(r => r.turn === turn).map(r => r.usage)); s.turnUsageQuality = reportedTurn ? 'reported' : 'derived'; }
    return;
  }
  if (type === 'event_msg') {
    const e = p.type;
    if(e==='error'||e==='stream_error'){
      if(!s.agentError||at>=s.agentError.at)s.agentError={at,message:evidenceText(p.message,240)||'Codex reported an error'};
      activity(s,`error:${record.ordinal??at}`,at,'status','Agent error','failure',meta,eventTime);
      return;
    }
    if(['task_started','turn_started','agent_message','exec_command_begin'].includes(e)&&(!s.agentError||at>s.agentError.at))s.agentError={at,message:null};
    if (e === 'token_count') { s.legacyTotal = usage(p.info?.total_token_usage) ?? s.legacyTotal; s.lastUsage = usage(p.info?.last_token_usage) ?? s.lastUsage; s.usageAt = at; const capacity = number(p.info?.model_context_window); if (capacity !== null) { s.capacity = capacity; s.capacityAt = at; } if (p.rate_limits) s.quota = { value: p.rate_limits, at }; return; }
    if (e === 'item_completed'||e==='item_started') { completedItem(s, p.item, at, p,meta); return; }
    if(e==='thread_settings_applied'){const settings=p.thread_settings??{};s.model=string(settings.model)??s.model;s.effort=string(settings.reasoning_effort??settings.reasoningEffort??settings.effort)??s.effort;s.cwd=string(settings.cwd)??s.cwd;s.serviceTier=string(settings.service_tier??settings.serviceTier)??s.serviceTier;if(string(settings.cwd))s.cwdAt=at;if(string(settings.model))s.modelAt=at;if(string(settings.reasoning_effort??settings.reasoningEffort??settings.effort))s.effortAt=at;return;}
    if (e === 'task_started' || e === 'turn_started') { const turn = identity(p.turn_id) ?? s.currentTurn ?? `offset:${meta?.offset ?? at}`; s.currentTurn = turn; s.turnStarts[turn] = iso(p.started_at)??at; s.turnUsage = null; s.lastTask = 'started'; const capacity = number(p.model_context_window); if (capacity !== null) { s.capacity = capacity; s.capacityAt = at; } activity(s, `start:${turn}`, at, 'turn', 'Turn started',undefined,meta,eventTime); return; }
    if (e === 'task_complete' || e === 'task_completed' || e === 'turn_complete' || e === 'turn_completed' || e === 'turn_aborted') { const turn = identity(p.turn_id) ?? s.currentTurn ?? at; s.completed[turn] = true; const start = s.turnStarts[turn]; const d = number(p.duration_ms) ?? (start ? Math.max(0, Date.parse(at) - Date.parse(start)) : null); if (d !== null) s.durations[turn] = d; s.lastTask = e === 'turn_aborted' ? 'aborted' : 'complete'; activity(s, `done:${turn}`, at, 'turn', e === 'turn_aborted' ? 'Turn stopped' : 'Turn completed',undefined,meta,eventTime);if(e==='turn_aborted'){for(const tool of Object.values(s.tools))if(tool.turn===turn&&tool.phase!=='finished')tool.phase='interrupted';signal(s,'blocker','Native turn was interrupted',at,`turn:${turn}:aborted`,meta,'native-interrupted',eventTime);}else signal(s,'summary',evidenceText(p.last_agent_message,1600)||'Native turn completed; overall task completion is reported, not independently verified',at,`turn:${turn}:completed`,meta,'native-turn-complete',eventTime);return; }
    if (e === 'thread_name_updated' && string(p.name)) { s.title = p.name; return; }
    if (e === 'context_compacted') { s.lastUsage = null; activity(s, `compact:${meta?.offset ?? at}`, at, 'compaction', 'Context compacted'); return; }
    if(e==='user_message'){signal(s,'request',p.message??p.text,at,identity(p.id)??`user:${record.ordinal??at}`,meta,'user-input',eventTime);return;}
    if(e==='agent_message'){signal(s,p.phase==='final_answer'?'summary':'progress',p.message??p.text,at,identity(p.id)??`message:${record.ordinal??at}`,meta,p.phase??'public-update',eventTime);return;}
    if (['agent_reasoning','agent_reasoning_section_break','agent_reasoning_raw_content','mcp_startup_update','mcp_startup_complete'].includes(e)) return;
  }
  if (type === 'response_item') {
    const id = identity(p.call_id ?? p.id); const t = p.type;
    if((t==='message'&&p.role==='assistant'||['function_call','custom_tool_call','local_shell_call'].includes(t))&&(!s.agentError||at>s.agentError.at))s.agentError={at,message:null};
    if(t==='message'){const text=contentText(p.content);if(p.role==='user')signal(s,'request',text,at,id??`user:${record.ordinal??at}`,meta,'user-input',eventTime);else if(p.role==='assistant')signal(s,p.phase==='final_answer'?'summary':'progress',text,at,id??`message:${record.ordinal??at}`,meta,p.phase??'public-update',eventTime);return;}
    if(t==='agent_message'){signal(s,'subagent',contentText(p.content),at,id??`subagent:${record.ordinal??at}`,meta,'public-subagent-message',eventTime);return;}
    if(t==='compaction'){s.lastUsage=null;activity(s,`compact:${id??record.ordinal??at}`,at,'compaction','Context compacted',undefined,meta,eventTime);return;}
    if (['function_call','custom_tool_call','local_shell_call','web_search_call'].includes(t) && id) {
      const toolName = string(p.name);
      // Completed typed items use the same native call identity and replace this provisional observation.
      if (!s.tools[id]) s.tools[id] = { name: toolName ?? (t === 'web_search_call' ? 'Web search' : 'Tool call'), at, outcome: 'unknown', origin: 'raw', turn: s.currentTurn, durationMs: null,phase:'pending',wrapper:toolName==='exec'&&!p.namespace };
      const args=argumentsObject(p.arguments??p.input);
      if(toolName==='update_plan'||toolName?.endsWith('__update_plan')){if(Array.isArray(args?.plan))signal(s,'plan',args.plan.filter(Boolean).map((step:any)=>`${step.status??'unknown'}: ${evidenceText(step.step??step.text,500)}`).join('\n'),at,id,meta,'reported-checklist',eventTime);}
      else if(p.namespace==='collaboration'||/spawn_agent|followup_task|send_message/.test(toolName??''))signal(s,'subagent',`${toolName}: ${evidenceText(args?.task_name??args?.target,200)}\n${evidenceText(args?.message,1200)}`,at,id,meta,'assignment',eventTime);
      else signal(s,'tool',`${toolName??'Tool call'}${args?.cmd?`: ${evidenceText(args.cmd,700)}`:args?.file_path?`: ${evidenceText(args.file_path,300)}`:''}; invocation recorded`,at,id,meta,'pending',eventTime);
      if ((toolName === 'update_plan' || toolName?.endsWith('__update_plan')) && typeof p.arguments === 'string') { try { const args = JSON.parse(p.arguments); if (Array.isArray(args?.plan) && args.plan.length) s.checklist = { total: args.plan.length, completed: args.plan.filter((x: any) => x?.status === 'completed').length }; } catch { /* Incomplete tool arguments carry no progress evidence. */ } }
      return;
    }
    if (['function_call_output','custom_tool_call_output'].includes(t) && id) {
      let result: any = p.output; if (typeof result === 'string' && result.startsWith('{')) { try { result = JSON.parse(result); } catch { result = null; } }
      const exit = typeof result?.exit_code === 'number' ? result.exit_code : typeof result?.exitCode === 'number' ? result.exitCode : null;
      if(s.tools[id]&&exit!==null&&(!s.agentError||at>=s.agentError.at))s.agentError={at,message:exit===0?null:`${s.tools[id].name} failed (exit ${exit})`};
      const tool = s.tools[id]; if (tool){if(tool.outcome==='unknown'&&exit!==null)tool.outcome=exit===0?'success':'failure';tool.endedAt=at;tool.phase='finished';const elapsed=Date.parse(at)-Date.parse(tool.at);if(tool.durationMs===null&&elapsed>0)tool.durationMs=elapsed;activity(s,`tool:${id}`,at,'tool',tool.name,tool.outcome,meta,eventTime);const summary=outputEvidence(typeof result==='object'?result?.output??result?.stdout??result?.stderr:p.output);signal(s,tool.outcome==='failure'?'blocker':'result',summary||`${tool.name} returned; ${tool.outcome==='unknown'?'outcome unavailable':tool.outcome}`,at,`${id}:result`,meta,tool.outcome,eventTime);}return;
    }
    return;
  }
  if (type === 'compacted') { s.lastUsage = null; activity(s, `compact:${meta?.offset ?? at}`, at, 'compaction', 'Context compacted'); return; }
  if (['world_state','agent_metadata','inter_agent_communication_metadata'].includes(type)) return;
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
  if(s.agentError?.message)out.agentError=metric(s.agentError.message,source,'native agent error','reported',undefined,s.agentError.at);
  out.startedAt = s.startedAt; out.lastActivityAt = s.lastAt; out.cwd = s.cwd; out.project = s.cwd?.replace(/\\/g,'/').replace(/\/$/,'').split('/').pop() ?? null; out.branch = s.branch;
  if (s.lastAt && Date.parse(now) - Date.parse(s.lastAt) < 15 * 60_000) out.state = metric('unknown',source,'runtime','derived','Recently active transcript; runtime and attachment are unconfirmed',observedAt);
  if (s.title) { out.name = s.title; out.nameSource = 'native title metadata'; }
  out.model = metric(s.model, source, 'session', s.model ? 'reported' : 'unavailable', undefined, s.modelAt??observedAt); out.effort = metric(s.effort, source, 'session', s.effort ? 'reported' : 'unavailable', undefined, s.effortAt??observedAt);
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
  out.latestActivity = s.activities.at(-1)?.label ?? 'Persisted session'; out.activities = s.activities.slice().sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));out.task=taskEvidence(s.taskEvidence,'Public requests, corrections, plans and observable tool evidence from the native rollout.');out.agentRole=s.agentRole;
  const slices=new Map<string,{model:string|null;usage:Usage;serviceTier:string|null}>();for(const response of modern){const key=`${response.model??''}:${response.serviceTier??''}`,old=slices.get(key);slices.set(key,{model:response.model??null,serviceTier:response.serviceTier??null,usage:old?sumUsage([old.usage,response.usage])!:response.usage});}out.usageBreakdown=[...slices.values()];
  const grouped = new Map<string, Session['tools'][number]>();
  const allTools = Object.values(s.tools); const typedTurns = new Set(allTools.filter(x => x.origin === 'typed').map(x => x.turn));
  // Paginated history persists concrete tool items in addition to presentation-level raw calls.
  // Count its native typed invocations once; raw calls are a fallback for legacy-only turns.
  const countedTools = allTools.filter(t => !t.wrapper || !typedTurns.has(t.turn));
  for (const t of countedTools) { let g = grouped.get(t.name); if (!g) { g = { name: t.name, category: /shell|exec|command/i.test(t.name) ? 'execution' : /file|patch|edit/i.test(t.name) ? 'edits' : /agent|spawn/i.test(t.name) ? 'agents' : 'tools', calls: 0, succeeded: 0, failed: 0, unknown: 0, durationMs: null, retries: null }; grouped.set(t.name, g); } g.calls++; if (t.outcome === 'success') g.succeeded++; else if (t.outcome === 'failure') g.failed++; else g.unknown++; if(t.phase==='pending'&&t.turn===s.currentTurn&&s.lastTask==='started')g.pending=(g.pending??0)+1;if(t.phase==='in-flight'&&t.turn===s.currentTurn)g.inFlight=(g.inFlight??0)+1;if(t.phase==='interrupted')g.interrupted=(g.interrupted??0)+1;if (t.durationMs !== null) g.durationMs = (g.durationMs ?? 0) + t.durationMs; }
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
