import { describe, expect, it } from 'vitest';
import type { AdapterContext, FileInfo, SourceIO } from '../src/shared/adapter.js';
import { emptySession, sessionKey } from '../src/shared/types.js';
import { applyClaudeRuntime, createClaudeAdapter, parseClaudeListing, registryConversationMatches, registryIsLive, registryProcessStart } from '../src/providers/claude/index.js';
import { claudeSession, initialClaudeState, reduceClaudeRecord } from '../src/providers/claude/parser.js';

const id='11111111-1111-1111-1111-111111111111',other='22222222-2222-2222-2222-222222222222',at='2026-11-03T12:00:00.000Z';
const usage={input_tokens:10,output_tokens:20,cache_read_input_tokens:30,cache_creation_input_tokens:40,output_tokens_details:{thinking_tokens:5}};
function assistant(messageId:string,patch:Record<string,unknown>={}) { return {type:'assistant',sessionId:id,timestamp:at,uuid:`uuid:${messageId}`,message:{id:messageId,model:'claude-opus-test',usage,stop_reason:'end_turn',content:[],...patch}}; }
function state(){return initialClaudeState(id,'/synthetic/session.jsonl');}
function view(value:ReturnType<typeof state>){return claudeSession(value,'native:/synthetic',at);}

describe('Claude response accounting',()=>{
  it('counts repeated message IDs once while retaining separate tool blocks',()=>{
    const value=state();
    reduceClaudeRecord(value,assistant('response',{content:[{type:'tool_use',id:'tool-a',name:'Read',input:{}}]}));
    reduceClaudeRecord(value,assistant('response',{content:[{type:'tool_use',id:'tool-b',name:'Glob',input:{}}]}));
    expect(view(value).usage.value).toEqual({input:10,output:20,cachedInput:30,cacheCreation:40,reasoning:5,total:100});
    expect(view(value).tools.reduce((sum,tool)=>sum+tool.calls,0)).toBe(2);
  });
  it('finalized revisions replace provisional usage rather than adding it',()=>{
    const value=state();
    reduceClaudeRecord(value,assistant('response',{usage:{...usage,output_tokens:1},stop_reason:null}));
    expect(view(value).usage.value?.output).toBeNull();
    reduceClaudeRecord(value,assistant('response',{usage:{...usage,output_tokens:44}}));
    expect(view(value).usage.value?.output).toBe(44);
    expect(view(value).usage.value?.total).toBe(124);
    reduceClaudeRecord(value,{...assistant('response',{usage:{...usage,output_tokens:1},stop_reason:null}),isPartial:true});
    expect(view(value).usage.value?.output).toBe(44);
  });
  it('does not add cached or reasoning subsets as Codex-style categories',()=>{
    const value=state();reduceClaudeRecord(value,assistant('response'));
    expect(view(value).usage.value?.total).toBe(10+20+30+40);
    expect(view(value).usage.value?.reasoning).toBe(5);
  });
  it('excludes inherited ancestor records and preserves lineage',()=>{
    const value=state();
    reduceClaudeRecord(value,{...assistant('ancestor'),sessionId:other});
    reduceClaudeRecord(value,assistant('own'));
    expect(view(value).usage.value?.total).toBe(100);
    expect(view(value).forkedFromId).toBe(sessionKey('claude','native:/synthetic',other));
  });
  it('keeps main-agent and sidechain contributions separate',()=>{
    const main=state();reduceClaudeRecord(main,{...assistant('child'),isSidechain:true});reduceClaudeRecord(main,assistant('main'));
    const child=initialClaudeState(`${id}/agent:a`,'/synthetic/agent-a.jsonl',id);
    reduceClaudeRecord(child,{...assistant('child'),isSidechain:true});
    expect(view(main).usage.value?.total).toBe(100);
    expect(claudeSession(child,'native:/synthetic',at).parentId).toBe(sessionKey('claude','native:/synthetic',id));
    expect(claudeSession(child,'native:/synthetic',at).usage.value?.total).toBe(100);
  });
  it('ignores cumulative cost-state when counting locally attributable usage',()=>{
    const value=state();reduceClaudeRecord(value,assistant('main'));
    reduceClaudeRecord(value,{type:'cost-state',sessionId:id,totalCostUSD:999,modelUsage:{test:{inputTokens:1e9}},hasUnknownModelCost:false});
    expect(view(value).usage.value?.total).toBe(100);
    expect(view(value).cost.value).toBeNull();
  });
  it('keeps unknown tool results outside the success denominator and correlates edits',()=>{
    const value=state();
    reduceClaudeRecord(value,assistant('one',{content:[{type:'tool_use',id:'edit',name:'Edit',input:{file_path:'/synthetic/a.ts'}},{type:'tool_use',id:'read',name:'Read',input:{}}]}));
    reduceClaudeRecord(value,{type:'user',sessionId:id,timestamp:'2026-11-03T12:00:01Z',message:{content:[{type:'tool_result',tool_use_id:'edit',is_error:false}]},toolUseResult:{structuredPatch:[{lines:['+a','-b',' c']}]}});
    const result=view(value);expect(result.tools.find(tool=>tool.name==='Edit')).toMatchObject({calls:1,succeeded:1,failed:0,durationMs:1000});
    expect(result.tools.find(tool=>tool.name==='Read')).toMatchObject({calls:1,succeeded:0,unknown:1});
    expect(result.edits.value).toEqual({files:1,additions:1,deletions:1});
  });
  it('preserves explicit title over generated title, summary and subsequent prompts',()=>{
    const value=state();
    reduceClaudeRecord(value,{type:'custom-title',sessionId:id,customTitle:'Native title'});
    reduceClaudeRecord(value,{type:'ai-title',sessionId:id,aiTitle:'AI title'});
    reduceClaudeRecord(value,{type:'summary',sessionId:id,summary:'Summary'});
    reduceClaudeRecord(value,{type:'user',sessionId:id,uuid:'prompt',timestamp:at,message:{content:'A later prompt'}});
    expect(view(value).name).toBe('Native title');
  });
  it('does not manufacture quota, context capacity, cost or ETA',()=>{
    const result=view(state());expect(result.allowanceIds).toEqual([]);expect(result.context.capacity.value).toBeNull();expect(result.timing.eta.value).toBeNull();expect(result.usage.value).toBeNull();expect(result.cost.value).toBeNull();
  });
  it('estimates a range only after three explicitly timed comparable checklist completions',()=>{
    const value=state();
    const todos=(completed:number,active:number)=>Array.from({length:5},(_,index)=>({content:`Synthetic step ${index}`,status:index<completed?'completed':index===active?'in_progress':'pending'}));
    const plan=(minute:number,completed:number,active:number)=>reduceClaudeRecord(value,{...assistant(`plan-${minute}`,{content:[{type:'tool_use',id:`plan-tool-${minute}`,name:'TodoWrite',input:{todos:todos(completed,active)}}]}),timestamp:new Date(Date.parse(at)+minute*60000).toISOString()});
    plan(0,0,0);plan(1,1,1);plan(2,2,2);
    expect(view(value).timing.eta.value).toBeNull();
    plan(3,3,3);
    expect(view(value).timing.eta.value).toMatchObject({lowMs:84000,highMs:180000,confidence:'low'});
    expect(view(value).timing.eta.value?.basis).toContain('reported');
  });
  it('skips private request blobs and tolerates unknown families',()=>{
    const value=state();reduceClaudeRecord(value,{type:'api-request-blob',sessionId:id,message:{content:'secret conversation'}});reduceClaudeRecord(value,{type:'future-shape',secret:'secret'});
    expect(JSON.stringify(value)).not.toContain('secret conversation');expect(value.unknown).toEqual({'future-shape':1});
  });
  it('does not treat hostile prototype keys as native response or tool identities',()=>{
    const value=state();reduceClaudeRecord(value,assistant('__proto__',{content:[{type:'tool_use',id:'constructor',name:'Edit',input:{file_path:'/x'}}]}));
    reduceClaudeRecord(value,{type:'__proto__'});expect(view(value).usage.value).toBeNull();expect(view(value).tools).toEqual([]);
  });
});

describe('Claude native state and process identity',()=>{
  it('validates JSON shape and refuses non-JSON interactive output',()=>{
    expect(parseClaudeListing(JSON.stringify([{sessionId:id,pid:7,status:'idle'}]))).toHaveLength(1);
    expect(()=>parseClaudeListing('Welcome to Claude')).toThrow();expect(()=>parseClaudeListing('{}')).toThrow();
  });
  it('keeps completed task state separate from a live process',()=>{
    const session=emptySession('claude','native',id,'test',at);applyClaudeRuntime(session,{sessionId:id,pid:7,status:'idle',state:'done',kind:'background'},at);
    expect(session.runtime.reachable).toBe(true);expect(session.state.value).toBe('complete');
  });
  it('distinguishes idle, approval, input and historical records',()=>{
    for(const [external,expected] of [[{pid:7,status:'idle'},'idle'],[{pid:7,status:'waiting',waitingFor:'permission prompt'},'approval'],[{pid:7,status:'waiting',waitingFor:'input needed'},'input']] as const){
      const session=emptySession('claude','native',id,'test',at);applyClaudeRuntime(session,external,at);expect(session.state.value).toBe(expected);
    }
    expect(view(state()).state.value).toBe('historical');
  });
  it('rejects dead registry entries, reused PIDs, and unrelated executables',async()=>{
    const procStart=(BigInt(Date.parse(at))*10000n+116444736000000000n).toString();
    const registry={pid:7,sessionId:id,procStart,pidDomain:'win32:test'};
    expect(registryProcessStart(registry)).toBe(at);
    const context={processIdentity:async()=>null} as unknown as AdapterContext;
    expect(await registryIsLive(registry,context)).toBe(false);
    context.processIdentity=async()=>({pid:7,startedAt:'2026-11-03T12:01:00Z',executable:'C:/claude.exe'});expect(await registryIsLive(registry,context)).toBe(false);
    context.processIdentity=async()=>({pid:7,startedAt:at,executable:'C:/unrelated.exe'});expect(await registryIsLive(registry,context)).toBe(false);
    context.processIdentity=async()=>({pid:7,startedAt:at,executable:'C:/claude.exe'});expect(await registryIsLive(registry,context)).toBe(true);
  });
  it('does not bind stale registry IDs to a process after contradictory clear/resume transcript evidence',()=>{
    const procStart=(BigInt(Date.parse(at))*10000n+116444736000000000n).toString(),registry={pid:7,sessionId:id,procStart,pidDomain:'win32:test',cwd:'C:/project',updatedAt:Date.parse(at)+5000};
    const claimed=emptySession('claude','native',id,'test',at);claimed.cwd='C:/project';claimed.lastActivityAt='2026-11-03T12:00:03Z';
    expect(registryConversationMatches(registry,claimed,[claimed])).toBe(true);
    const newer=emptySession('claude','native',other,'test',at);newer.cwd='C:/project';newer.lastActivityAt='2026-11-03T12:00:20Z';
    expect(registryConversationMatches(registry,claimed,[claimed,newer])).toBe(false);
    claimed.lastActivityAt='2026-11-02T12:00:00Z';expect(registryConversationMatches(registry,claimed,[claimed])).toBe(false);
  });
});

function fixtureContext(){
  const files=new Map<string,string>();let now=Date.parse(at),listing:unknown[]=[],commands:string[][]=[];
  const info=(path:string,isDirectory=false):FileInfo=>({path,isDirectory,size:Buffer.byteLength(files.get(path)??''),mtimeMs:now,birthtimeMs:now,identity:path});
  const io:SourceIO={
    join:(...parts)=>parts.join('/').replace(/\/+/g,'/'),
    async list(path){const result=new Map<string,FileInfo>();for(const name of files.keys())if(name.startsWith(path+'/')){const tail=name.slice(path.length+1),part=tail.split('/')[0];result.set(part,info(path+'/'+part,tail.includes('/')));}return[...result.values()];},
    async stat(path){return files.has(path)?info(path):null;},
    async read(path,offset,length){return Buffer.from(files.get(path)??'').subarray(offset,offset+length);},
    async text(path){return files.get(path)??null;}
  };
  const context:AdapterContext={root:'/fixture',namespace:'native:/fixture',now:at,io,
    async ingest(path,initial,reduce){const value=initial();for(const line of (files.get(path)??'').split('\n'))if(line)reduce(value,JSON.parse(line),{offset:0,generation:0,source:path});return{state:value,complete:true,bytesRead:0,generation:0,errors:0};},
    async command(_exe,args){commands.push(args);return{code:0,stderr:'',stdout:args.includes('--help')?'--json --all':JSON.stringify(listing)};},
    async processIdentity(){return null;}
  };
  return{context,files,commands,setListing(value:unknown[]){listing=value;},advance(ms=6000){now+=ms;context.now=new Date(now).toISOString();}};
}
describe('Claude automatic discovery',()=>{
  it('discovers existing and later sessions in the same directory and follows native renames',async()=>{
    const fixture=fixtureContext(),adapter=createClaudeAdapter();
    const transcript=(nativeId:string)=>JSON.stringify({type:'user',sessionId:nativeId,timestamp:at,uuid:'p',cwd:'/same-project',message:{content:'Work on this'}})+'\n';
    fixture.files.set(`/fixture/projects/actual-native-slug/${id}.jsonl`,transcript(id));
    fixture.setListing([{sessionId:id,pid:7,status:'idle',cwd:'/same-project',name:'First native name',kind:'interactive'}]);
    let result=await adapter.poll(fixture.context);expect(result.sessions).toHaveLength(1);expect(result.sessions[0].name).toBe('First native name');expect(result.sessions[0].state.value).toBe('idle');
    fixture.files.set(`/fixture/projects/actual-native-slug/${other}.jsonl`,transcript(other));
    fixture.setListing([{sessionId:id,pid:7,status:'busy',cwd:'/same-project',name:'Renamed native name',kind:'interactive'},{sessionId:other,pid:8,status:'idle',cwd:'/same-project',name:'Second native name',kind:'interactive'}]);fixture.advance();
    result=await adapter.poll(fixture.context);expect(result.sessions).toHaveLength(2);expect(new Set(result.sessions.map(session=>session.id)).size).toBe(2);expect(result.sessions.find(session=>session.nativeId===id)?.name).toBe('Renamed native name');
    expect(fixture.commands.every(command=>command.join(' ')==='agents --help'||command.join(' ')==='agents --json --all')).toBe(true);
  });
  it('places subagent transcripts beneath their native parent',async()=>{
    const fixture=fixtureContext(),adapter=createClaudeAdapter();
    fixture.files.set(`/fixture/projects/slug/${id}.jsonl`,JSON.stringify(assistant('main'))+'\n');
    fixture.files.set(`/fixture/projects/slug/${id}/subagents/agent-ab12.jsonl`,JSON.stringify({...assistant('child'),isSidechain:true})+'\n');
    const result=await adapter.poll(fixture.context);expect(result.sessions).toHaveLength(2);const child=result.sessions.find(session=>session.parentId);expect(child?.parentId).toBe(sessionKey('claude',fixture.context.namespace,id));
  });
  it('waits for native conversation identity instead of leaving a duplicate background-job tab',async()=>{
    const fixture=fixtureContext(),adapter=createClaudeAdapter();fixture.setListing([{id:'job-abc',kind:'background',state:'working'}]);
    let result=await adapter.poll(fixture.context);expect(result.sessions).toEqual([]);expect(result.diagnostics.some(item=>item.code==='claude-background-conversation-pending')).toBe(true);
    fixture.setListing([{id:'job-abc',sessionId:id,kind:'background',state:'working',name:'Full native name'}]);fixture.advance();
    result=await adapter.poll(fixture.context);expect(result.sessions).toHaveLength(1);expect(result.sessions[0].nativeId).toBe(id);
  });
});
