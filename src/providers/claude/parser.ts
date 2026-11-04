import { createHash } from 'node:crypto';
import { emptySession, emptyUsage, metric, sessionKey, type Activity, type Session, type ToolSummary, type Usage, type UsageSlice } from '../../shared/types.js';
import type { RecordMeta } from '../../shared/adapter.js';
import { normalizeTimestamp } from '../../shared/time.js';
import { evidenceText, isContextSummary, initialTaskEvidence, observeTaskEvidence, outputEvidence, taskEvidence, type TaskEvidenceState } from '../../server/task-evidence.js';

type SavedResponse = { usage: Usage; at: string; turn: string | null; final: boolean; model: string | null;serviceTier?:string|null;cacheCreation5m?:number|null;cacheCreation1h?:number|null };
type SavedTool = { name: string; at: string | null; resultAt: string | null; outcome: 'success' | 'failure' | 'unknown';phase?:'pending'|'in-flight'|'finished'|'interrupted'; editedFile: string | null; additions: number | null; deletions: number | null };
export interface ClaudeState {
  nativeId: string; parentNativeId: string | null; source: string; cwd: string | null; branch: string | null;
  startedAt: string | null; lastActivityAt: string | null; model: string | null; effort: string | null;
  explicitTitle: string | null; generatedTitle: string | null; summary: string | null; firstPrompt: string | null;
  forkedFrom: string | null; responses: Record<string, SavedResponse>; tools: Record<string, SavedTool>;
  turns: Record<string, { startedAt: string; durationMs: number | null }>; currentTurn: string | null;
  activities: Activity[]; unknown: Record<string, number>; checklist: { completed: number; total: number } | null;
  checklistTiming: { ids: string[]; started: Record<string,string>; durations: Record<string,number> };
  tailObservedAt: string | null; nativeCost: { usd: number; modelNames: string[]; unknown: boolean } | null;
  taskEvidence?:TaskEvidenceState;
  contextClearedAt?:string;
}

export function cleanText(value: unknown, length = 160): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g, '[redacted]').replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, '$1 [redacted]').trim().slice(0, length);
}
export function iso(value: unknown): string | null {return normalizeTimestamp(value);}
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
function nativeKey(value:unknown):string|null {return typeof value==='string'&&value.length>0&&value.length<=512&&!['__proto__','constructor','prototype'].includes(value)?value:null;}
export function claudeUsage(raw: any, final = true): Usage {
  const input = number(raw?.input_tokens), cachedInput = number(raw?.cache_read_input_tokens), cacheCreation = number(raw?.cache_creation_input_tokens);
  const output = final ? number(raw?.output_tokens) : null;
  const reasoning = number(raw?.output_tokens_details?.thinking_tokens ?? raw?.thinking_tokens);
  return { input, output, cachedInput, cacheCreation, reasoning, total: input !== null && output !== null ? input + output + (cachedInput ?? 0) + (cacheCreation ?? 0) : null };
}
export function initialClaudeState(nativeId: string, source: string, parentNativeId: string | null = null): ClaudeState {
  return { nativeId, source, parentNativeId, cwd: null, branch: null, startedAt: null, lastActivityAt: null, model: null, effort: null, explicitTitle: null, generatedTitle: null, summary: null, firstPrompt: null, forkedFrom: null, responses: {}, tools: {}, turns: {}, currentTurn: null, activities: [], unknown: {}, checklist: null, checklistTiming:{ids:[],started:{},durations:{}}, tailObservedAt: null, nativeCost: null,taskEvidence:initialTaskEvidence(nativeId) };
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
function addActivity(state: ClaudeState, activity: Activity,meta?:RecordMeta&{ingestedAt?:string},originalTimestamp?:string|number) {
  const index = state.activities.findIndex(item => item.id === activity.id);
  activity.occurredAt=activity.at;activity.ingestedAt=(index>=0?state.activities[index].ingestedAt:null)??meta?.ingestedAt??new Date().toISOString();activity.originalTimestamp=typeof originalTimestamp==='string'||typeof originalTimestamp==='number'?originalTimestamp:activity.at;
  if (index >= 0) state.activities[index] = activity; else state.activities.push(activity);
  state.activities.sort((a,b) => a.at.localeCompare(b.at)||a.id.localeCompare(b.id)); state.activities = state.activities.slice(-80);
}
function signal(state:ClaudeState,kind:Parameters<typeof observeTaskEvidence>[1]['kind'],text:unknown,at:string,id:string,meta?:RecordMeta&{ingestedAt?:string},status?:string,originalTimestamp?:string|number){state.taskEvidence??=initialTaskEvidence(state.nativeId);observeTaskEvidence(state.taskEvidence,{kind,text,source:state.source,occurredAt:at,nativeId:id,turnId:state.currentTurn,ingestedAt:meta?.ingestedAt,status,originalTimestamp});}
function category(name: string): string {
  if (/edit|write|patch/i.test(name)) return 'File edits';
  if (/read|glob|grep|search/i.test(name)) return 'Read & search';
  if (/bash|shell|command|terminal/i.test(name)) return 'Commands';
  if (/agent|task/i.test(name)) return 'Agents';
  if (/mcp/i.test(name)) return 'Integrations';
  return 'Other';
}
const knownIgnored = new Set(['api-request', 'api-request-shape', 'api-request-blob', 'session-owner', 'file-history-snapshot', 'queue-operation', 'progress', 'attachment', 'mode', 'permission-mode', 'atis-latch', 'last-prompt', 'tools-used', 'agent-name', 'agent-color', 'pr-link', 'saved_hook_context', 'hook-context', 'task-notification']);

/** Retains accounting and bounded public task evidence; private reasoning and raw tool output are excluded. */
export function reduceClaudeRecord(state: ClaudeState, record: any,meta?:RecordMeta&{ingestedAt?:string}): void {
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
    if (record.subtype === 'compact_boundary' && at) {state.contextClearedAt=state.contextClearedAt && state.contextClearedAt>at?state.contextClearedAt:at;addActivity(state,{id: record.uuid ?? `compact:${at}`,at,kind:'compaction',label:'Context compacted'},meta,record.timestamp);}
    if(['turn_aborted','interrupted'].includes(record.subtype))for(const tool of Object.values(state.tools))if(!tool.resultAt)tool.phase='interrupted';
    return;
  }
  if(record.type==='progress'&&at){const toolId=nativeKey(record.toolUseID??record.toolUseId??record.data?.toolUseId);if(toolId&&state.tools[toolId]&&['bash_progress','tool_progress'].includes(record.data?.type)){state.tools[toolId].phase='in-flight';signal(state,'tool',`${state.tools[toolId].name}: native progress reported`,at,`progress:${toolId}:${record.uuid??at}`,meta,'in-flight',record.timestamp);}return;}
  if (record.type === 'user') {
    const content = record.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part:any)=>part.type==='text').map((part:any)=>part.text).join(' ') : '';
    if(at && typeof text==='string' && isContextSummary(text))signal(state,'summary',text,at,record.uuid??`summary:${at}`,meta,'context-summary',record.timestamp);
    const realPrompt = !!text && !isContextSummary(text) && record.isMeta !== true && !/^\s*(?:<|\/)/.test(text) && !(Array.isArray(content) && content.some((part:any)=>part.type==='tool_result'));
    if (realPrompt && at) {
      const id = nativeKey(record.uuid) ?? `user:${at}`;
      if (!state.turns[id]) { state.turns[id] = {startedAt:at,durationMs:null}; state.currentTurn=id; }
      state.firstPrompt ||= cleanText(text, 90);
      addActivity(state,{id:`turn:${id}`,at,kind:'turn',label:'User turn started'},meta,record.timestamp);signal(state,'request',text,at,id,meta,'user-input',record.timestamp);
    }
    if (Array.isArray(content)) for (const part of content) {
      if (part.type !== 'tool_result' || !nativeKey(part.tool_use_id)) continue;
      const tool = state.tools[part.tool_use_id]; if (!tool) continue;
      tool.outcome = part.is_error === true ? 'failure' : part.is_error === false ? 'success' : 'unknown';
      tool.resultAt = at;
      tool.phase=record.toolUseResult?.interrupted===true?'interrupted':'finished';
      const result = record.toolUseResult;
      if (result && typeof result === 'object' && tool.editedFile) {
        const patch = result.structuredPatch;
        if (Array.isArray(patch)) {
          let adds=0,dels=0;
          for (const hunk of patch) if (Array.isArray(hunk.lines)) for (const line of hunk.lines) {if(typeof line==='string' && line.startsWith('+')) adds++; else if(typeof line==='string' && line.startsWith('-')) dels++;}
          tool.additions=adds;tool.deletions=dels;
        }
      }
      if (at){addActivity(state,{id:`tool:${part.tool_use_id}`,at,kind:tool.editedFile?'edit':'tool',label:tool.name,detail:tool.editedFile??undefined,outcome:tool.outcome},meta,record.timestamp);const summary=Array.isArray(part.content)?part.content.filter((part:any)=>part.type==='text').map((part:any)=>part.text).join('\n'):part.content;signal(state,tool.outcome==='failure'?'blocker':'result',outputEvidence(summary)||`${tool.name} returned; ${tool.outcome==='unknown'?'outcome unavailable':tool.outcome}`,at,`${part.tool_use_id}:result`,meta,tool.outcome,record.timestamp);}
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
      if (!previous || final || !previous.final) state.responses[id]={usage:claudeUsage(message.usage,final),at,turn:previous?.turn??state.currentTurn,final,model:typeof message.model==='string'?cleanText(message.model):null,serviceTier:cleanText(message.usage.service_tier,80),cacheCreation5m:number(message.usage.cache_creation?.ephemeral_5m_input_tokens),cacheCreation1h:number(message.usage.cache_creation?.ephemeral_1h_input_tokens)};
    }
    if(at&&Array.isArray(message.content)){const publicText=message.content.filter((part:any)=>part.type==='text').map((part:any)=>part.text??'').join('\n');if(publicText)signal(state,message.stop_reason==='end_turn'?'summary':'progress',publicText,at,`${id??record.uuid??at}:text`,meta,message.stop_reason==='end_turn'?'native-final':'public-update',record.timestamp);}
    if (Array.isArray(message.content)) for(const part of message.content) {
      if (part.type!=='tool_use' || !nativeKey(part.id) || typeof part.name!=='string') continue;
      if (!state.tools[part.id]) {
        const editedFile=/^(?:Edit|Write|MultiEdit|NotebookEdit)$/i.test(part.name)?cleanText(part.input?.file_path??part.input?.notebook_path,2048):null;
        state.tools[part.id]={name:cleanText(part.name,120)??'Tool',at,resultAt:null,outcome:'unknown',editedFile,additions:null,deletions:null,phase:'pending'};
      }
      const tool=state.tools[part.id];
      if (part.name==='TodoWrite' && Array.isArray(part.input?.todos)){observeChecklist(state,part.input.todos,at);if(at)signal(state,'plan',part.input.todos.filter(Boolean).map((todo:any)=>`${todo.status??'unknown'}: ${evidenceText(todo.content,500)}`).join('\n'),at,part.id,meta,'reported-checklist',record.timestamp);}
      if(at&&['TaskCreate','TaskUpdate'].includes(part.name))signal(state,'plan',`${part.name}: ${evidenceText(part.input?.subject??part.input?.taskId,300)} ${evidenceText(part.input?.status,80)}`,at,part.id,meta,'reported-task-list',record.timestamp);
      if(at&&['Task','Agent'].includes(part.name))signal(state,'subagent',`${part.name}: ${evidenceText(part.input?.description,300)}\n${evidenceText(part.input?.prompt,1000)}`,at,part.id,meta,'assignment',record.timestamp);
      if (at){addActivity(state,{id:`tool:${part.id}`,at,kind:tool.editedFile?'edit':'tool',label:tool.name,detail:tool.editedFile??undefined,outcome:tool.outcome},meta,record.timestamp);signal(state,'tool',`${tool.name}${part.input?.command?`: ${evidenceText(part.input.command,700)}`:tool.editedFile?`: ${tool.editedFile}`:''}; invocation recorded`,at,part.id,meta,'pending',record.timestamp);}
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
  const slices=new Map<string,UsageSlice>();
  for(const response of responses){const key=`${response.model??''}:${response.serviceTier??''}`,old=slices.get(key);const aggregate=(a:number|null|undefined,b:number|null|undefined)=>a!==null&&a!==undefined&&b!==null&&b!==undefined?a+b:null;slices.set(key,{model:response.model,serviceTier:response.serviceTier??null,usage:old?sumClaudeUsage([{...response,usage:old.usage},response]):response.usage,cacheCreation5m:old?aggregate(old.cacheCreation5m,response.cacheCreation5m):response.cacheCreation5m??null,cacheCreation1h:old?aggregate(old.cacheCreation1h,response.cacheCreation1h):response.cacheCreation1h??null});}session.usageBreakdown=[...slices.values()];
  session.task=taskEvidence(state.taskEvidence,complete?'Public task evidence recovered from the native transcript.':'Observed prefix and recent public task evidence; historical backfill is incomplete.');session.agentRole=state.parentNativeId?'implementation':'unknown';
  // Request tokens are useful evidence but are not an authoritative current-context gauge.
  const last=Object.entries(state.responses).sort(([idA,a],[idB,b])=>a.at.localeCompare(b.at)||idA.localeCompare(idB)).at(-1)?.[1];
  const clearedAt=state.contextClearedAt??state.activities.filter(activity=>activity.kind==='compaction').map(activity=>activity.at).sort().at(-1);
  if(last && last.usage.input!==null && (!clearedAt || last.at>clearedAt)) {
    session.context.used=metric(last.usage.input+(last.usage.cachedInput??0)+(last.usage.cacheCreation??0),state.source,'latest API request input','derived','Latest reported input plus cache read and cache creation; excludes output and lifetime consumption. Pending work may change context.',last.at);
    // Keep the denominator tied to the response model, including after out-of-order historical backfill.
    if(last.model)session.model=metric(last.model,state.source,'latest response model','reported',undefined,last.at);
  }else if(clearedAt)session.context.used=metric<number>(null,state.source,'latest API request input','unavailable','Context was compacted; waiting for the next reported API usage.',clearedAt);
  session.activities=state.activities.slice().reverse();session.latestActivity=session.activities[0]?.label??'Persisted session';
  const tools=new Map<string,ToolSummary>();
  for(const tool of Object.values(state.tools)) {
    const summary=tools.get(tool.name)??{name:tool.name,category:category(tool.name),calls:0,succeeded:0,failed:0,unknown:0,durationMs:null,retries:null,pending:0};
    summary.calls++;if(tool.outcome==='success')summary.succeeded++;else if(tool.outcome==='failure')summary.failed++;else summary.unknown++;
    if(tool.at && tool.resultAt){const elapsed=Date.parse(tool.resultAt)-Date.parse(tool.at);if(elapsed>0)summary.durationMs=(summary.durationMs??0)+elapsed;}
    if(tool.phase==='pending'&&!tool.resultAt)summary.pending=(summary.pending??0)+1;
    if(tool.phase==='in-flight')summary.inFlight=(summary.inFlight??0)+1;if(tool.phase==='interrupted')summary.interrupted=(summary.interrupted??0)+1;
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
