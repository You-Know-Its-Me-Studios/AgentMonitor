import { describe,expect,it } from 'vitest';
import { initialCodexState,reduceCodex,sessionFromState } from '../src/providers/codex/parser.js';
import { mergeCodexObservations,readCodexTail } from '../src/providers/codex/tail.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NativeIO } from '../src/server/io.js';
import { initialClaudeState,reduceClaudeRecord,claudeSession } from '../src/providers/claude/parser.js';
import { applyRuntime,applyPersistedRuntimeReason,daemonFailureReason,newerRuntimeNotification } from '../src/providers/codex/index.js';
import { applyClaudeRuntime } from '../src/providers/claude/index.js';
import type { AdapterContext } from '../src/shared/adapter.js';
import { emptySession } from '../src/shared/types.js';
const id='00000001-0000-0000-0000-000000000001',parent='00000002-0000-0000-0000-000000000002',start='2026-11-03T20:02:00Z',later='2026-11-04T01:12:00Z';
const usage={input_tokens:100,output_tokens:20,total_tokens:120};
function meta(extra:Record<string,unknown>={}){return{type:'session_meta',timestamp:start,ordinal:0,payload:{id,timestamp:start,cwd:'/old',...extra}};}
describe('current provider observation',()=>{
  it('recovers the substantive task before a large output tail through bounded native user history without changing checkpoints',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-targeted-task-')),file=path.join(root,`rollout-${id}.jsonl`),database=new DatabaseSync(path.join(root,'native-history.sqlite'));
    try{
      database.exec('CREATE TABLE thread_items(thread_id TEXT,item_id TEXT,item_type TEXT,item_json TEXT,created_at_ms INTEGER,rollout_ordinal INTEGER,turn_id TEXT)');
      const brief={type:'UserMessage',id:'native-brief',content:[{type:'text',text:'Update the dashboard to recover the actual current task.\n'+('Required: preserve native identity and verify attribution.\n'.repeat(50))}]},status={type:'UserMessage',id:'native-status',content:[{type:'text',text:'How is the current work coming along?'}]},briefAt='2026-11-04T01:08:49.037Z';
      const insert=database.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)');insert.run(id,brief.id,'userMessage',JSON.stringify(brief),Date.parse(briefAt),754,'current');insert.run(id,status.id,'userMessage',JSON.stringify(status),Date.parse(later),1705,'current');insert.run(parent,'unrelated','userMessage',JSON.stringify({...status,id:'unrelated',content:[{type:'text',text:'Replace this with another conversation objective.'}]}),Date.parse(later),1800,'other');
      const typed=(item:any,at:string,ordinal:number)=>({type:'event_msg',timestamp:at,ordinal,payload:{type:'item_completed',thread_id:id,turn_id:'current',completed_at_ms:Date.parse(at),item}});
      await fs.writeFile(file,[meta(),typed(brief,briefAt,754),{type:'response_item',timestamp:later,payload:{type:'function_call_output',call_id:'huge',output:'x'.repeat(5*1024*1024)}},typed(status,later,1705),{type:'token_usage_record',timestamp:later,payload:{thread_id:id,turn_id:'current',response_id:'response',usage,thread_token_usage:usage}}].map(record=>JSON.stringify(record)).join('\n')+'\n');
      const native=new NativeIO();let rolloutBytes=0;const io={join:(...parts:string[])=>native.join(...parts),list:(dir:string)=>native.list(dir),stat:(name:string)=>native.stat(name),text:(name:string,max?:number)=>native.text(name,max),read:async(name:string,offset:number,length:number)=>{if(name===file)rolloutBytes+=length;return native.read(name,offset,length);}};
      const context:AdapterContext={root,namespace:'fixture-targeted',now:later,io,ingest:async()=>{throw new Error('Tail recovery must not advance the transactional prefix checkpoint');},command:async()=>({code:1,stdout:'',stderr:''}),processIdentity:async()=>null};
      const info=(await io.stat(file))!,tail=await readCodexTail(context,info,id,meta(),1024),prefix=initialCodexState(id);reduceCodex(prefix,meta());const merged=mergeCodexObservations(prefix,tail),session=sessionFromState(merged,context.namespace,'fixture',later);
      const expected=initialCodexState(id);reduceCodex(expected,meta());reduceCodex(expected,typed(brief,briefAt,754));reduceCodex(expected,typed(status,later,1705));
      expect(session.task?.objective.startsWith('Update')).toBe(true);expect(session.task?.id).toBe(sessionFromState(expected,context.namespace,'fixture',later).task?.id);expect(session.task?.items.some(item=>item.text.startsWith('How is'))).toBe(true);expect(session.task?.items.some(item=>item.text.includes('another conversation'))).toBe(false);expect(rolloutBytes).toBe(1024);expect(session.usage.value?.total).toBe(120);
      const replay=mergeCodexObservations(JSON.parse(JSON.stringify(merged)),await readCodexTail(context,info,id,meta(),1024));expect(sessionFromState(replay,context.namespace,'fixture',later).task?.id).toBe(session.task?.id);expect(new Set(replay.taskEvidence?.events.map(event=>event.id)).size).toBe(replay.taskEvidence?.events.length);
    }finally{database.close();await fs.rm(root,{recursive:true,force:true});}
  });
  it('uses explicit native runtime flags for running/approval/input and keeps loaded idle distinct from exited history',()=>{
    const context={now:later,namespace:'fixture'}as AdapterContext;
    for(const[status,expected,loaded]of [[{type:'active',activeFlags:[]},'running',true],[{type:'active',activeFlags:['waitingOnApproval']},'approval',true],[{type:'active',activeFlags:['waitingOnUserInput']},'input',true],[{type:'idle'},'idle',true],[{type:'notLoaded'},'historical',false]]as const){const session=emptySession('codex','fixture',id,'synthetic',later);applyRuntime(session,{status},context,false);expect(session.state.value).toBe(expected);expect(session.state.provenance.quality).toBe('reported');expect(session.runtime.loaded).toBe(loaded);expect(session.runtime.attachment).toBe('unknown');expect(session.state.provenance.reason).toBeTruthy();}
    const unsupported=emptySession('codex','fixture',id,'synthetic',later);applyRuntime(unsupported,{status:{type:'active',activeFlags:[{unknown:'future-flag'}]}},context,true);expect(unsupported.state.value).toBe('unknown');expect(unsupported.state.provenance.reason).toContain('unsupported active flags');
  });
  it('keeps denied runtime verification separate from current source collection and unfinished/interrupted evidence',()=>{
    const context={now:later,namespace:'fixture'}as AdapterContext,state=initialCodexState(id);reduceCodex(state,meta());reduceCodex(state,{type:'event_msg',timestamp:later,payload:{type:'task_started',turn_id:'turn'}});
    const session=sessionFromState(state,'fixture','synthetic',later);session.collection={lastCheckedAt:later,ingestedAt:later,evidenceAt:later,condition:'current',reason:'Native records reconciled'};applyPersistedRuntimeReason(session,state,context,daemonFailureReason('os error 10013'),later);
    expect(session.state.value).toBe('unknown');expect(session.runtime.reachable).toBe(false);expect(session.state.provenance.reason).toContain('Windows 10013');expect(session.state.provenance.reason).toContain('started turn with no recorded completion');expect(session.collection.condition).toBe('current');
    state.lastTask='aborted';applyPersistedRuntimeReason(session,state,context,daemonFailureReason('spawn EPERM'),later);expect(session.state.provenance.reason).toContain('interrupted turn');expect(session.state.provenance.reason).not.toContain('Windows 10013');
  });
  it('does not let an older status broadcast overwrite a newer authoritative thread read',()=>{
    expect(newerRuntimeNotification({__observerSequence:8},{__observerSequence:7,status:{type:'active'}})).toBe(false);expect(newerRuntimeNotification({__observerSequence:8},{__observerSequence:9,status:{type:'idle'}})).toBe(true);expect(newerRuntimeNotification({__observerSequence:8},{status:{type:'active'}})).toBe(false);
  });
  it('explains Claude idle and explicit waiting states without collapsing live process and completed task',()=>{
    const session=emptySession('claude','fixture',id,'synthetic',later);applyClaudeRuntime(session,{sessionId:id,pid:7,status:'idle',kind:'interactive'},later);expect(session.state.value).toBe('idle');expect(session.state.provenance.reason).toContain('idle live process');
    applyClaudeRuntime(session,{sessionId:id,pid:7,status:'waiting',waitingFor:'permission prompt'},later);expect(session.state.value).toBe('approval');expect(session.state.provenance.reason).toContain('explicitly reported');applyClaudeRuntime(session,{sessionId:id,pid:7,status:'idle',state:'done'},later);expect(session.state.value).toBe('complete');expect(session.runtime.reachable).toBe(true);expect(session.state.provenance.reason).toContain('process remains live');
  });
  it('uses native history ordinals to exclude copied subagent history even when its timestamps were rewritten after child creation',()=>{
    const state=initialCodexState(id);reduceCodex(state,meta({parent_thread_id:parent,subagent_history_start_ordinal:10,thread_source:'guardian_review',source:{subagent:{other:'guardian'}}}));
    reduceCodex(state,{type:'turn_context',timestamp:later,ordinal:2,payload:{turn_id:'inherited',model:'ancestor-model'}});
    reduceCodex(state,{type:'token_usage_record',timestamp:later,ordinal:3,payload:{response_id:'inherited',usage:{input_tokens:10000,output_tokens:100,total_tokens:10100},thread_token_usage:{input_tokens:10000,output_tokens:100,total_tokens:10100}}});
    reduceCodex(state,{type:'response_item',timestamp:later,ordinal:4,payload:{type:'message',role:'user',content:[{type:'input_text',text:'Ancestor instructions must not become this reviewer task.'}]}});
    reduceCodex(state,{type:'turn_context',timestamp:later,ordinal:10,payload:{turn_id:'own',model:'own-model',effort:'high'}});
    reduceCodex(state,{type:'token_usage_record',timestamp:later,ordinal:11,payload:{thread_id:id,turn_id:'own',response_id:'own',usage,thread_token_usage:{input_tokens:10100,output_tokens:120,total_tokens:10220}}});
    const session=sessionFromState(state,'fixture','source',later);expect(session.parentId).toBe(`codex:fixture:${parent}`);expect(session.agentRole).toBe('approval-reviewer');expect(session.usage.value?.total).toBe(120);expect(session.model.value).toBe('own-model');expect(session.task).toBeUndefined();
  });
  it('merges current tail without adding cumulative totals or overriding newer prefix metadata with canonical-header defaults',()=>{
    const prefix=initialCodexState(id);reduceCodex(prefix,meta());reduceCodex(prefix,{type:'turn_context',timestamp:'2026-11-03T21:00:00Z',payload:{turn_id:'turn',cwd:'/new',model:'model-a',effort:'medium'}});reduceCodex(prefix,{type:'token_usage_record',timestamp:'2026-11-03T21:01:00Z',payload:{turn_id:'turn',response_id:'one',usage,thread_token_usage:usage}});
    const tail=initialCodexState(id);reduceCodex(tail,meta());reduceCodex(tail,{type:'token_usage_record',timestamp:later,payload:{turn_id:'turn',response_id:'two',model:'model-b',usage,thread_token_usage:{input_tokens:200,output_tokens:40,total_tokens:240}}});
    const merged=mergeCodexObservations(prefix,tail),session=sessionFromState(merged,'fixture','source',later);expect(session.cwd).toBe('/new');expect(session.usage.value?.total).toBe(240);expect(session.usageBreakdown?.map(slice=>slice.model).sort()).toEqual(['model-a','model-b']);expect(session.lastActivityAt).toBe('2026-11-04T01:12:00.000Z');
    const replay=mergeCodexObservations(merged,tail);expect(sessionFromState(replay,'fixture','source',later).usage.value?.total).toBe(240);expect(Object.keys(replay.responses)).toHaveLength(2);
  });
  it('keeps raw distinct tools in a typed turn and separates explicit in-flight/interrupted from missing outcomes',()=>{
    const state=initialCodexState(id);reduceCodex(state,meta());reduceCodex(state,{type:'turn_context',timestamp:start,payload:{turn_id:'turn'}});
    reduceCodex(state,{type:'response_item',timestamp:start,payload:{type:'function_call',name:'update_plan',call_id:'plan',arguments:'{"plan":[{"step":"Observe","status":"in_progress"}]}'}});
    reduceCodex(state,{type:'event_msg',timestamp:later,payload:{type:'item_started',turn_id:'turn',item:{type:'CommandExecution',id:'command',status:'inProgress'}}});
    let session=sessionFromState(state,'fixture','source',later);expect(session.tools.reduce((sum,tool)=>sum+tool.calls,0)).toBe(2);expect(session.tools.find(tool=>tool.name==='Shell command')).toMatchObject({inFlight:1,unknown:1,durationMs:null});
    reduceCodex(state,{type:'event_msg',timestamp:'2026-11-04T01:13:00Z',payload:{type:'turn_aborted',turn_id:'turn'}});session=sessionFromState(state,'fixture','source',later);expect(session.tools.find(tool=>tool.name==='Shell command')).toMatchObject({interrupted:1,unknown:1});
  });
  it('retains response model/tier at occurrence rather than applying latest session metadata to mixed usage',()=>{
    const state=initialCodexState(id);reduceCodex(state,meta());for(const [index,model,tier]of [[0,'old-model','flex'],[1,'new-model','priority']]as const){reduceCodex(state,{type:'event_msg',timestamp:start,payload:{type:'thread_settings_applied',thread_settings:{model,service_tier:tier,reasoning_effort:'high'}}});reduceCodex(state,{type:'token_usage_record',timestamp:start,payload:{turn_id:'turn',response_id:`response-${index}`,usage}});}
    const session=sessionFromState(state,'fixture','source',later);expect(session.usageBreakdown).toEqual(expect.arrayContaining([expect.objectContaining({model:'old-model',serviceTier:'flex'}),expect.objectContaining({model:'new-model',serviceTier:'priority'})]));
  });
  it('preserves Claude cache-write TTL categories separately for per-response pricing',()=>{
    const state=initialClaudeState(id,'synthetic');for(const [index,model]of [[0,'claude-old'],[1,'claude-new']]as const)reduceClaudeRecord(state,{type:'assistant',sessionId:id,timestamp:start,message:{id:`response-${index}`,model,stop_reason:'end_turn',content:[],usage:{input_tokens:100,output_tokens:20,cache_creation_input_tokens:30,cache_read_input_tokens:40,cache_creation:{ephemeral_5m_input_tokens:10,ephemeral_1h_input_tokens:20},service_tier:'standard'}}});
    const session=claudeSession(state,'fixture',later);expect(session.usageBreakdown).toHaveLength(2);expect(session.usageBreakdown?.every(slice=>slice.cacheCreation5m===10&&slice.cacheCreation1h===20&&slice.serviceTier==='standard')).toBe(true);
  });
});
