import { createHash } from 'node:crypto';
import { emptySession, emptyUsage, metric, sessionKey, type Activity, type Session, type ToolSummary, type Usage } from '../../shared/types.js';

type SavedResponse = { usage: Usage; at: string; turn: string | null; final: boolean; model: string | null };
type SavedTool = { name: string; at: string | null; resultAt: string | null; outcome: 'success' | 'failure' | 'unknown'; editedFile: string | null; additions: number | null; deletions: number | null };
export interface ClaudeState {
  nativeId: string; parentNativeId: string | null; source: string; cwd: string | null; branch: string | null;
  startedAt: string | null; lastActivityAt: string | null; model: string | null; effort: string | null;
  explicitTitle: string | null; generatedTitle: string | null; summary: string | null; firstPrompt: string | null;
  forkedFrom: string | null; responses: Record<string, SavedResponse>; tools: Record<string, SavedTool>;
  turns: Record<string, { startedAt: string; durationMs: number | null }>; currentTurn: string | null;
  activities: Activity[]; unknown: Record<string, number>; checklist: { completed: number; total: number } | null;
  checklistTiming: { ids: string[]; started: Record<string,string>; durations: Record<string,number> };
  tailObservedAt: string | null; nativeCost: { usd: number; modelNames: string[]; unknown: boolean } | null;
}

export function cleanText(value: unknown, length = 160): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, '[redacted]').replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, '$1 [redacted]').trim().slice(0, length);
}
export function iso(value: unknown): string | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function nativeKey(value:unknown):string|null {return typeof value==='string'&&value.length>0&&value.length<=512&&!['__proto__','constructor','prototype'].includes(value)?value:null;}
export function claudeUsage(raw: any, final = true): Usage {
  const input = number(raw?.input_tokens), cachedInput = number(raw?.cache_read_input_tokens), cacheCreation = number(raw?.cache_creation_input_tokens);
  const output = final ? number(raw?.output_tokens) : null;
  const reasoning = number(raw?.output_tokens_details?.thinking_tokens ?? raw?.thinking_tokens);
  return { input, output, cachedInput, cacheCreation, reasoning, total: input !== null && output !== null ? input + output + (cachedInput ?? 0) + (cacheCreation ?? 0) : null };
}
export function initialClaudeState(nativeId: string, source: string, parentNativeId: string | null = null): ClaudeState {
  return { nativeId, source, parentNativeId, cwd: null, branch: null, startedAt: null, lastActivityAt: null, model: null, effort: null, explicitTitle: null, generatedTitle: null, summary: null, firstPrompt: null, forkedFrom: null, responses: {}, tools: {}, turns: {}, currentTurn: null, activities: [], unknown: {}, checklist: null, checklistTiming:{ids:[],started:{},durations:{}}, tailObservedAt: null, nativeCost: null };
}
function observeChecklist(state:ClaudeState,todos:any[],at:string|null) {
  const items=todos.filter(todo=>todo&&typeof todo.content==='string'&&['pending','in_progress','completed'].includes(todo.status));
  const ids=items.map(todo=>typeof todo.id==='string'?`id:${todo.id}`:createHash('sha256').update(todo.content).digest('hex').slice(0,24));
  state.checklist={completed:items.filter(todo=>todo.status==='completed').length,total:items.length};
  state.checklistTiming??={ids:[],started:{},durations:{}};
  if(state.checklistTiming.ids.length && !ids.some(id=>state.checklistTiming.ids.includes(id)))state.checklistTiming={ids:[],started:{},durations:{}};
  const timing=state.checklistTiming;timing.ids=ids;
  if(!at)return;
  for(let index=0;index<items.length;index++) {
    const id=ids[index],item=items[index];
    if(item.status==='in_progress')timing.started[id]??=at;
    if(item.status==='completed' && timing.started[id] && timing.durations[id]===undefined) {
      const duration=Date.parse(at)-Date.parse(timing.started[id]);if(duration>0)timing.durations[id]=duration;
    }
  }
}
function addActivity(state: ClaudeState, activity: Activity) {
  const index = state.activities.findIndex(item => item.id === activity.id);
  if (index >= 0) state.activities[index] = activity; else state.activities.push(activity);
  state.activities.sort((a,b) => a.at.localeCompare(b.at)); state.activities = state.activities.slice(-80);
}
function category(name: string): string {
  if (/edit|write|patch/i.test(name)) return 'File edits';
  if (/read|glob|grep|search/i.test(name)) return 'Read & search';
  if (/bash|shell|command|terminal/i.test(name)) return 'Commands';
  if (/agent|task/i.test(name)) return 'Agents';
  if (/mcp/i.test(name)) return 'Integrations';
  return 'Other';
}
const knownIgnored = new Set(['api-request', 'api-request-shape', 'api-request-blob', 'session-owner', 'file-history-snapshot', 'queue-operation', 'progress', 'attachment', 'mode', 'permission-mode', 'atis-latch', 'last-prompt', 'tools-used', 'agent-name', 'agent-color', 'pr-link', 'saved_hook_context', 'hook-context', 'task-notification']);

/** Retains numeric accounting and structural events only, never conversation or tool output. */
export function reduceClaudeRecord(state: ClaudeState, record: any): void {
  if (!record || typeof record !== 'object' || typeof record.type !== 'string') return;
  const recordSession = typeof record.sessionId === 'string' ? record.sessionId : record.session_id;
  if (!state.parentNativeId && recordSession && recordSession !== state.nativeId) {
    state.forkedFrom ||= recordSession; return;
  }
  if (state.parentNativeId && recordSession && recordSession !== state.parentNativeId && recordSession !== state.nativeId) return;
  if (!state.parentNativeId && record.isSidechain === true) return;
  if (state.parentNativeId && record.isSidechain === false && ['assistant', 'user'].includes(record.type)) return;
  const at = iso(record.timestamp);
  if (at) {
    if (!state.startedAt || at < state.startedAt) state.startedAt = at;
    if (!state.lastActivityAt || at > state.lastActivityAt) state.lastActivityAt = at;
  }
  if (typeof record.cwd === 'string') state.cwd = cleanText(record.cwd, 2048);
  if (typeof record.gitBranch === 'string') state.branch = cleanText(record.gitBranch);
  if (typeof record.perTurnEffort === 'string' || typeof record.effort === 'string') state.effort = cleanText(record.perTurnEffort ?? record.effort, 40);
  if (record.type === 'custom-title' && typeof record.customTitle === 'string') state.explicitTitle = cleanText(record.customTitle);
  if (record.type === 'ai-title' && typeof record.aiTitle === 'string') state.generatedTitle = cleanText(record.aiTitle);
  if (record.type === 'summary' && typeof record.summary === 'string') state.summary = cleanText(record.summary);
  if (record.type === 'session_meta') {
    if (typeof record.name === 'string') state.explicitTitle = cleanText(record.name);
    if (typeof record.forkedFromSessionId === 'string') state.forkedFrom = record.forkedFromSessionId;
  }
  if (record.type === 'cost-state') {
    // These totals can include subagents and restored fork history. Never add them to response accounting.
    if (number(record.totalCostUSD) !== null && record.modelUsage && typeof record.modelUsage === 'object') state.nativeCost = { usd: record.totalCostUSD, modelNames: Object.keys(record.modelUsage).filter(name=>!name.startsWith('<')).slice(0,20), unknown: record.hasUnknownModelCost !== false };
    if (!state.startedAt) state.startedAt = iso(record.startTime);
    return;
  }
  if (record.type === 'system') {
    if (record.subtype === 'turn_duration' && number(record.durationMs) !== null && state.currentTurn) state.turns[state.currentTurn].durationMs = record.durationMs;
    if (record.subtype === 'compact_boundary' && at) addActivity(state,{id: record.uuid ?? `compact:${at}`,at,kind:'compaction',label:'Context compacted'});
    return;
  }
  if (record.type === 'user') {
    const content = record.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part:any)=>part.type==='text').map((part:any)=>part.text).join(' ') : '';
    const realPrompt = !!text && record.isMeta !== true && !/^\s*(?:<|\/)/.test(text) && !(Array.isArray(content) && content.some((part:any)=>part.type==='tool_result'));
    if (realPrompt && at) {
      const id = nativeKey(record.uuid) ?? `user:${at}`;
      if (!state.turns[id]) { state.turns[id] = {startedAt:at,durationMs:null}; state.currentTurn=id; }
      state.firstPrompt ||= cleanText(text, 90);
      addActivity(state,{id:`turn:${id}`,at,kind:'turn',label:'User turn started'});
    }
    if (Array.isArray(content)) for (const part of content) {
      if (part.type !== 'tool_result' || !nativeKey(part.tool_use_id)) continue;
      const tool = state.tools[part.tool_use_id]; if (!tool) continue;
      tool.outcome = part.is_error === true ? 'failure' : part.is_error === false ? 'success' : 'unknown';
      tool.resultAt = at;
      const result = record.toolUseResult;
      if (result && typeof result === 'object' && tool.editedFile) {
        const patch = result.structuredPatch;
        if (Array.isArray(patch)) {
          let adds=0,dels=0;
          for (const hunk of patch) if (Array.isArray(hunk.lines)) for (const line of hunk.lines) {if(typeof line==='string' && line.startsWith('+')) adds++; else if(typeof line==='string' && line.startsWith('-')) dels++;}
          tool.additions=adds;tool.deletions=dels;
        }
      }
      if (at) addActivity(state,{id:`tool:${part.tool_use_id}`,at,kind:tool.editedFile?'edit':'tool',label:tool.name,detail:tool.editedFile??undefined,outcome:tool.outcome});
    }
    return;
  }
  if (record.type === 'assistant') {
    const message=record.message; if (!message || typeof message !== 'object') return;
    if (typeof message.model === 'string' && !message.model.startsWith('<')) state.model=cleanText(message.model);
    const id=nativeKey(message.id);
    const hasStopReason=typeof message.stop_reason==='string';
    const outputCount=number(message.usage?.output_tokens);
    const final = record.isPartial !== true && record.provisional !== true && (hasStopReason || (outputCount!==null && outputCount>1));
    if (id && message.usage && at && !record.isApiErrorMessage) {
      const previous=state.responses[id];
      if (!previous || final || !previous.final) state.responses[id]={usage:claudeUsage(message.usage,final),at,turn:previous?.turn??state.currentTurn,final,model:state.model};
    }
    if (Array.isArray(message.content)) for(const part of message.content) {
      if (part.type!=='tool_use' || !nativeKey(part.id) || typeof part.name!=='string') continue;
      if (!state.tools[part.id]) {
        const editedFile=/^(?:Edit|Write|MultiEdit|NotebookEdit)$/i.test(part.name)?cleanText(part.input?.file_path??part.input?.notebook_path,2048):null;
        state.tools[part.id]={name:cleanText(part.name,120)??'Tool',at,resultAt:null,outcome:'unknown',editedFile,additions:null,deletions:null};
      }
      const tool=state.tools[part.id];
      if (part.name==='TodoWrite' && Array.isArray(part.input?.todos)) observeChecklist(state,part.input.todos,at);
      if (at) addActivity(state,{id:`tool:${part.id}`,at,kind:tool.editedFile?'edit':'tool',label:tool.name,detail:tool.editedFile??undefined,outcome:tool.outcome});
    }
    return;
  }
  if (['custom-title','ai-title','summary','session_meta'].includes(record.type) || knownIgnored.has(record.type)) return;
  let kind=cleanText(record.type,80)??'unknown';if(['__proto__','constructor','prototype'].includes(kind))return;if(!Object.hasOwn(state.unknown,kind)&&Object.keys(state.unknown).length>=64)kind='other families';state.unknown[kind]=(state.unknown[kind]??0)+1;
}

export function sumClaudeUsage(responses: SavedResponse[]): Usage {
  const fields: (keyof Usage)[]=['input','output','cachedInput','cacheCreation','reasoning','total'];
  const result=emptyUsage();
  for(const field of fields) {
    const values=responses.map(response=>response.usage[field]);
    result[field]=values.length && values.every(value=>value!==null)?values.reduce<number>((sum,value)=>sum+(value??0),0):null;
  }
  return result;
}
export function claudeSession(state: ClaudeState, namespace: string, now: string, complete = true): Session {
  const session=emptySession('claude',namespace,state.nativeId,state.source,now);
  session.name=state.explicitTitle??state.generatedTitle??state.summary??state.firstPrompt??session.name;
  session.nameSource=state.explicitTitle?'Explicit native title':state.generatedTitle?'Generated native title':state.summary?'Native summary':state.firstPrompt?'First user prompt':'Native ID';
  session.cwd=state.cwd;session.project=state.cwd?.split(/[\\/]/).filter(Boolean).at(-1)??null;session.branch=state.branch;
  session.startedAt=state.startedAt;session.lastActivityAt=state.lastActivityAt;
  session.parentId=state.parentNativeId?sessionKey('claude',namespace,state.parentNativeId):null;
  session.forkedFromId=state.forkedFrom?sessionKey('claude',namespace,state.forkedFrom):null;
  session.model=metric(state.model,state.source,'session',state.model?'reported':'unavailable',undefined,state.lastActivityAt??now);
  session.effort=metric(state.effort,state.source,'current turn',state.effort?'reported':'unavailable','Only explicitly persisted effort is shown',state.lastActivityAt??now);
  const responses=Object.values(state.responses),usage=sumClaudeUsage(responses),turnResponses=responses.filter(response=>response.turn===state.currentTurn && state.currentTurn!==null);
  const provisional=responses.some(response=>!response.final);
  const reason=!complete?'Progressive backfill: totals cover the observed portion of this transcript':provisional?'Output contains an unfinished response; its placeholder count is unavailable':undefined;
  session.usage=metric(responses.length?usage:null,state.source,'main agent; locally attributable responses',reason?'derived':responses.length?'reported':'unavailable',reason??'Cache read and cache creation are separate from uncached input',state.lastActivityAt??now);
  session.turnUsage=metric(turnResponses.length?sumClaudeUsage(turnResponses):null,state.source,'current user turn',turnResponses.length?(!complete?'derived':'reported'):'unavailable',!complete?'Progressive backfill: only explicitly correlated responses in the observed portion are included':undefined,state.lastActivityAt??now);
  // Request tokens are useful evidence but are not an authoritative current-context gauge.
  const last=responses.at(-1);
  if(last && last.usage.input!==null) session.context.used=metric(last.usage.input+(last.usage.cachedInput??0)+(last.usage.cacheCreation??0),state.source,'latest API request input','estimated','Latest request input including cache; context may have changed since',last.at);
  session.activities=state.activities.slice().reverse();session.latestActivity=session.activities[0]?.label??'Persisted session';
  const tools=new Map<string,ToolSummary>();
  for(const tool of Object.values(state.tools)) {
    const summary=tools.get(tool.name)??{name:tool.name,category:category(tool.name),calls:0,succeeded:0,failed:0,unknown:0,durationMs:null,retries:null};
    summary.calls++;if(tool.outcome==='success')summary.succeeded++;else if(tool.outcome==='failure')summary.failed++;else summary.unknown++;
    if(tool.at && tool.resultAt) summary.durationMs=(summary.durationMs??0)+Math.max(0,Date.parse(tool.resultAt)-Date.parse(tool.at));
    tools.set(tool.name,summary);
  }
  session.tools=[...tools.values()].sort((a,b)=>b.calls-a.calls);
  const edits=Object.values(state.tools).filter(tool=>tool.editedFile && tool.resultAt && tool.outcome!=='failure');
  if(edits.length) session.edits=metric({files:new Set(edits.map(tool=>tool.editedFile)).size,additions:edits.every(tool=>tool.additions!==null)?edits.reduce((sum,tool)=>sum+(tool.additions??0),0):null,deletions:edits.every(tool=>tool.deletions!==null)?edits.reduce((sum,tool)=>sum+(tool.deletions??0),0):null},state.source,'observed Claude edit tool results','derived','File attribution comes from edit tool invocations; missing patch details remain unavailable',state.lastActivityAt??now);
  const durations=Object.values(state.turns).map(turn=>turn.durationMs).filter((value):value is number=>value!==null);
  session.timing.completedTurns=durations.length;session.timing.checklist=state.checklist;
  const measuredSteps=Object.entries(state.checklistTiming?.durations??{}).filter(([id])=>state.checklistTiming.ids.includes(id)).map(([,duration])=>duration).sort((a,b)=>a-b);
  if(state.checklist && measuredSteps.length>=3 && measuredSteps.at(-1)!/measuredSteps[0]<=4) {
    const remaining=state.checklist.total-state.checklist.completed;
    const lowStep=measuredSteps[Math.floor((measuredSteps.length-1)*0.25)],highStep=measuredSteps[Math.ceil((measuredSteps.length-1)*0.75)];
    session.timing.eta=metric({lowMs:Math.floor(remaining*lowStep*0.7),highMs:Math.ceil(remaining*highStep*1.5),confidence:'low',basis:`Reported checklist: ${state.checklist.completed}/${state.checklist.total} steps; ${measuredSteps.length} comparable completed steps timed in this plan. Completion is reported, not independently verified.`},state.source,'reported checklist remaining steps','estimated','Assumes remaining steps resemble the measured steps; no inference from tokens or tool-call counts',now);
  }
  if(state.startedAt) session.timing.elapsedMs=metric(Math.max(0,Date.parse(state.lastActivityAt??now)-Date.parse(state.startedAt)),state.source,'recorded session timespan','derived','Includes gaps between resumed attachments',now);
  if(durations.length) {
    session.timing.lastTurnMs=metric(durations.at(-1)!,state.source,'completed user turn','reported',undefined,state.lastActivityAt??now);
    session.timing.averageTurnMs=metric(durations.reduce((a,b)=>a+b,0)/durations.length,state.source,'completed user turns','derived',undefined,state.lastActivityAt??now);
  }
  const buckets=new Map<string,{at:string;input:number;output:number;tools:number}>();
  for(const response of responses) {const at=new Date(Math.floor(Date.parse(response.at)/60000)*60000).toISOString(),bucket=buckets.get(at)??{at,input:0,output:0,tools:0};bucket.input+=(response.usage.input??0)+(response.usage.cachedInput??0)+(response.usage.cacheCreation??0);bucket.output+=response.usage.output??0;buckets.set(at,bucket);}
  for(const tool of Object.values(state.tools))if(tool.at){const at=new Date(Math.floor(Date.parse(tool.at)/60000)*60000).toISOString(),bucket=buckets.get(at)??{at,input:0,output:0,tools:0};bucket.tools++;buckets.set(at,bucket);}
  session.trends=[...buckets.values()].sort((a,b)=>a.at.localeCompare(b.at)).slice(-90);
  if(!complete)session.diagnostics.push({provider:'claude',namespace,level:'info',code:'claude-backfill',message:'Large transcript is being backfilled progressively. Usage covers the observed portion until complete.',at:now});
  if(Object.keys(state.unknown).length)session.diagnostics.push({provider:'claude',namespace,level:'info',code:'claude-record-coverage',message:`Unrecognized record families skipped: ${Object.keys(state.unknown).slice(0,12).join(', ')}`,at:now});
  return session;
}
