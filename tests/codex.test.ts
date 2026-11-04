import { describe, expect, it } from 'vitest';
import { initialCodexState, quotaFromSnapshot, reduceCodex, sessionFromState } from '../src/providers/codex/parser.js';
import { createCodexAdapter, parseDaemonProbe } from '../src/providers/codex/index.js';
import type { AdapterContext, FileInfo } from '../src/shared/adapter.js';

const id = '00000001-0000-0000-0000-000000000001';
const other = '00000002-0000-0000-0000-000000000002';
const at = '2026-11-03T12:00:00.000Z';
const record = (type: string, payload: any, timestamp = at) => ({ type, payload, timestamp });
const u = (input: number, output: number) => ({ input_tokens: input, cached_input_tokens: 20, output_tokens: output, reasoning_output_tokens: 2, total_tokens: input+output });
function state() { const s = initialCodexState(id); reduceCodex(s,record('session_meta',{id,timestamp:at,cwd:'C:\\work'})); return s; }
describe('Codex accounting and source inference',() => {
  it('validates passive daemon version responses before opening a proxy',() => {
    expect(parseDaemonProbe('{"status":"running","cliVersion":"0.166.0","appServerVersion":"0.166.0","socketPath":"C:\\\\codex\\\\app-server-control.sock"}')).toEqual({version:'0.166.0',socket:'C:\\codex\\app-server-control.sock'});
    expect(()=>parseDaemonProbe('{}')).toThrow('Unsupported');expect(()=>parseDaemonProbe('[]')).toThrow('Invalid');
  });
  it('does not sum repeated legacy cumulative snapshots or cache/reasoning subsets',() => {
    const s=state(); for(let n=0;n<4;n++)reduceCodex(s,record('event_msg',{type:'token_count',info:{total_token_usage:u(100,10),last_token_usage:u(100,10),model_context_window:200000}}));
    const result=sessionFromState(s,'native:test','fixture',at); expect(result.usage.value?.total).toBe(110); expect(result.usage.value?.input).toBe(100); expect(result.usage.value?.output).toBe(10); expect(result.context.capacity.value).toBe(200000);
  });
  it('deduplicates native response identity and uses finalized revisions without adding legacy totals',() => {
    const s=state(); reduceCodex(s,record('turn_context',{turn_id:'turn-a'}));
    for(const value of [u(100,5),u(100,10),u(100,10)])reduceCodex(s,record('token_usage_record',{thread_id:id,turn_id:'turn-a',response_id:'response-a',usage:value,thread_token_usage:value,turn_token_usage:value}));
    reduceCodex(s,record('event_msg',{type:'token_count',info:{total_token_usage:u(100,10)}}));
    expect(Object.keys(s.responses)).toHaveLength(1); expect(sessionFromState(s,'native:test','fixture',at).usage.value?.total).toBe(110);
  });
  it('excludes copied ancestor usage, retains fork lineage and separates subagent consumption',() => {
    const s=initialCodexState(id); reduceCodex(s,record('session_meta',{id:other,timestamp:at}));
    reduceCodex(s,record('token_usage_record',{thread_id:other,response_id:'inherited',usage:u(900,99)}));
    reduceCodex(s,record('session_meta',{id,timestamp:at,forked_from_id:other,source:{subagent:{thread_spawn:{parent_thread_id:other}}}}));
    reduceCodex(s,record('token_usage_record',{thread_id:other,response_id:'ancestor',usage:u(900,99)}));
    reduceCodex(s,record('token_usage_record',{thread_id:id,turn_id:'own',response_id:'own',usage:u(100,10),thread_token_usage:u(1000,109)}));
    const result=sessionFromState(s,'native:test','fixture',at); expect(result.usage.value?.total).toBe(110); expect(result.parentId).toBe(`codex:native:test:${other}`); expect(result.forkedFromId).toBe(result.parentId);
  });
  it('counts typed completed invocations once instead of raw calls plus typed items plus outputs',() => {
    const s=state(); reduceCodex(s,record('turn_context',{turn_id:'turn'}));
    reduceCodex(s,record('response_item',{type:'function_call',name:'exec_command',call_id:'call-one'}));
    const typed=record('event_msg',{type:'item_completed',turn_id:'turn',item:{type:'CommandExecution',id:'call-one',status:'completed',exit_code:0,duration:{secs:1,nanos:500000000}}});
    reduceCodex(s,typed);reduceCodex(s,typed);reduceCodex(s,record('response_item',{type:'function_call_output',call_id:'call-one',output:'{"exit_code":0}'}));
    reduceCodex(s,record('event_msg',{type:'item_completed',turn_id:'turn',item:{type:'CommandExecution',id:'call-two',status:'inProgress'}}));
    const result=sessionFromState(s,'native:test','fixture',at); expect(result.tools).toHaveLength(1);expect(result.tools[0]).toMatchObject({calls:2,succeeded:1,unknown:1,durationMs:1500});
  });
  it('never manufactures liveness from a completed or recently modified transcript',() => {
    const s=state();reduceCodex(s,record('event_msg',{type:'task_started',turn_id:'a'}));reduceCodex(s,record('event_msg',{type:'task_complete',turn_id:'a'},'2026-11-03T12:00:10Z'));
    const result=sessionFromState(s,'native:test','fixture','2026-11-03T12:00:11Z');expect(result.runtime.loaded).toBe(false);expect(result.state.value).toBe('unknown');expect(result.state.provenance.reason).toContain('Recently active transcript');expect(result.timing.completedTurns).toBe(1);expect(result.timing.lastTurnMs.value).toBe(10000);
    expect(sessionFromState(s,'native:test','fixture','2026-11-04T12:00:00Z').state.value).toBe('historical');
  });
  it('marks old and expired allowance snapshots stale without refilling them',() => {
    const out=quotaFromSnapshot({limit_id:'codex',primary:{used_percent:73,window_minutes:300,resets_at:Date.parse(at)/1000+10}},'test','fixture',at,'2026-11-03T12:01:00Z');
    expect(out[0].usedPercent.value).toBe(73);expect(out[0].usedPercent.provenance.quality).toBe('stale');expect(out[0].windowMinutes).toBe(300);
  });
  it('ages context snapshots using usage observation time and invalidates footprint after compaction',() => {
    const s=state();reduceCodex(s,record('event_msg',{type:'token_count',info:{total_token_usage:u(100,10),last_token_usage:u(100,10)}}));
    reduceCodex(s,record('event_msg',{type:'task_started',turn_id:'later'},'2026-11-03T12:10:00Z'));
    expect(sessionFromState(s,'test','fixture','2026-11-03T12:10:01Z').context.used.provenance.quality).toBe('stale');
    reduceCodex(s,record('compacted',{},'2026-11-03T12:10:02Z'));const result=sessionFromState(s,'test','fixture','2026-11-03T12:10:03Z');expect(result.context.used.value).toBeNull();expect(result.usage.value?.total).toBe(110);
  });
  it('leaves unavailable context, quota, ETA and price unavailable and skips unknown schemas',() => {
    const s=state();reduceCodex(s,record('future_record',{secret:'never retain this'}));const result=sessionFromState(s,'test','fixture',at);expect(result.context.used.value).toBeNull();expect(result.context.capacity.value).toBeNull();expect(result.timing.eta.value).toBeNull();expect(result.cost.value).toBeNull();expect(JSON.stringify(s)).not.toContain('never retain this');expect(result.diagnostics[0].code).toBe('codex-record-coverage');
  });
  it('rejects prototype keys and never retains arbitrary unknown family text',() => {
    const s=state();for(const key of ['__proto__','constructor','prototype','toString','valueOf']){reduceCodex(s,record('response_item',{type:'function_call',name:'test',call_id:key}));reduceCodex(s,record('event_msg',{type:'task_started',turn_id:key}));reduceCodex(s,record('response_item',{type:'function_call_output',call_id:key,output:'{"exit_code":0}'}));}reduceCodex(s,record('event_msg',{type:'item_completed',item:{id:'constructor',type:'CommandExecution',status:'completed'}}));reduceCodex(s,record('secret-value-do-not-retain',{}));
    expect(Object.keys(s.tools)).toHaveLength(0);expect(JSON.stringify(s)).not.toContain('secret-value-do-not-retain');expect(Object.getPrototypeOf(s.tools)).toBe(Object.prototype);
  });
  it('accepts malformed or future optional payload fields without blocking later valid usage',() => {
    const s=state();reduceCodex(s,record('response_item',{type:'function_call',name:17,call_id:'safe',arguments:'null'}));reduceCodex(s,record('response_item',{type:'function_call',name:'update_plan',call_id:'safe2',arguments:'{"plan":[null,{"status":"completed"}]}'}));reduceCodex(s,record('token_usage_record',{thread_id:id,turn_id:'turn',response_id:'response',usage:u(100,10),thread_token_usage:u(100,10)}));
    expect(sessionFromState(s,'test','fixture',at).usage.value?.total).toBe(110);expect(s.checklist).toEqual({completed:1,total:2});
  });
});

function fakeContext() {
  const files=new Map<string,string>();const cache=new Map<string,{state:any;lines:number}>();
  const info=(path:string):FileInfo=>({path,size:Buffer.byteLength(files.get(path)??''),mtimeMs:Date.parse(at),birthtimeMs:1,identity:path,isDirectory:false});
  const context:AdapterContext={root:'/codex',namespace:'fixture',now:at,io:{join:(...x)=>x.join('/'),list:async path=>[...files.keys()].filter(k=>k.startsWith(`${path}/`)&&!k.slice(path.length+1).includes('/')).map(info),stat:async path=>files.has(path)?info(path):null,text:async path=>files.get(path)??null,read:async(path,offset,length)=>Buffer.from(files.get(path)??'').subarray(offset,offset+length)},command:async()=>({stdout:'',stderr:'No daemon',code:1}),processIdentity:async()=>null,ingest:async(path,initial,reduce)=>{let item=cache.get(path);if(!item){item={state:initial(),lines:0};cache.set(path,item);}const lines=(files.get(path)??'').split('\n').filter(Boolean);for(const line of lines.slice(item.lines))reduce(item.state,JSON.parse(line),{offset:0,generation:0,source:path});item.lines=lines.length;return{state:structuredClone(item.state),complete:true,bytesRead:1,generation:0,errors:0}}};
  return {context,files};
}
describe('Codex passive discovery',()=>{
  it('automatically finds existing/new independent sessions and follows native renames without identity changes',async()=>{
    const {context,files}=fakeContext();const adapter=createCodexAdapter();const path=`/codex/sessions/rollout-${id}.jsonl`;
    files.set(path,JSON.stringify(record('session_meta',{id,timestamp:at,cwd:'/same'}))+'\n');files.set('/codex/session_index.jsonl',JSON.stringify({id,thread_name:'First native title',updated_at:at})+'\n');
    const first=await adapter.poll(context);expect(first.sessions.map(x=>x.nativeId)).toEqual([id]);expect(first.sessions[0].name).toBe('First native title');const stable=first.sessions[0].id;
    files.set('/codex/session_index.jsonl',files.get('/codex/session_index.jsonl')+JSON.stringify({id,thread_name:'Renamed native title',updated_at:'2026-11-03T12:00:20Z'})+'\n');files.set(`/codex/sessions/rollout-${other}.jsonl`,JSON.stringify(record('session_meta',{id:other,timestamp:at,cwd:'/same'}))+'\n');context.now='2026-11-03T12:00:20Z';
    const second=await adapter.poll(context);expect(second.sessions).toHaveLength(2);expect(second.sessions.find(x=>x.id===stable)?.name).toBe('Renamed native title');expect(second.sessions.every(x=>!x.runtime.loaded)).toBe(true);await adapter.close?.();
  });
});
