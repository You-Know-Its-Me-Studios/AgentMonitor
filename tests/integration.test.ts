import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheStore } from '../src/server/store.js';
import { NativeIO } from '../src/server/io.js';
import { createCodexAdapter } from '../src/providers/codex/index.js';
import { createClaudeAdapter } from '../src/providers/claude/index.js';
import type { AdapterContext } from '../src/shared/adapter.js';

const nativeA='11111111-1111-1111-1111-111111111111',nativeB='22222222-2222-2222-2222-222222222222',started='2026-11-03T12:00:00Z';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(provider:'codex'|'claude') {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),`agent-monitor-integration-${provider}-`));cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'provider'),cache=path.join(root,'dashboard.sqlite');await fs.mkdir(source,{recursive:true});
  let store=new CacheStore(cache);cleanups.push(async()=>store.close());
  const io=new NativeIO(),commands:string[][]=[];let listing:any[]=[],now=Date.parse(started),forbiddenReads=0;
  // Authentication/configuration files are deliberate sentinels: no adapter may read them.
  await fs.writeFile(path.join(source,provider==='codex'?'auth.json':'.credentials.json'),'DO NOT READ');
  const originalRead=io.read.bind(io);io.read=async(file,offset,length)=>{if(/(?:auth|credentials|settings)\.json$/.test(file)){forbiddenReads++;throw new Error('Attempted forbidden provider read');}return originalRead(file,offset,length);};
  const context:AdapterContext={root:source,namespace:`fixture:${provider}:${source}`,now:started,io,
    ingest:(file,initial,reduce)=>store.ingest(`${provider}:${source}`,io,file,initial,reduce),
    async command(_executable,args){commands.push(args);return provider==='claude'?{code:0,stdout:args.includes('--help')?'--json --all':JSON.stringify(listing),stderr:''}:{code:1,stdout:'',stderr:'No existing fixture daemon'};},
    async processIdentity(){return null;}
  };
  return{source,context,commands,get forbiddenReads(){return forbiddenReads;},setListing(value:any[]){listing=value;},advance(){now+=12000;context.now=new Date(now).toISOString();},async restart(){store.close();store=new CacheStore(cache);},async write(relative:string,records:any[]){const file=path.join(source,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,records.map(record=>JSON.stringify(record)+'\n').join(''));return file;}};
}
function codexRecords(id:string){return[{type:'session_meta',timestamp:started,payload:{id,cwd:'/same/project',timestamp:started}},{type:'turn_context',timestamp:started,payload:{turn_id:'turn-1',model:'gpt-test',effort:'high'}},{type:'event_msg',timestamp:started,payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:20,cached_input_tokens:50,reasoning_output_tokens:5,total_tokens:120},last_token_usage:{input_tokens:100,output_tokens:20,total_tokens:120}}}}];}
function claudeRecords(id:string):any[]{return[{type:'custom-title',sessionId:id,customTitle:`Persisted ${id.slice(0,2)}`},{type:'user',sessionId:id,uuid:`user:${id}`,timestamp:started,cwd:'/same/project',message:{content:'Synthetic user request'}},{type:'assistant',sessionId:id,timestamp:started,uuid:`record:${id}`,message:{id:`response:${id}`,model:'claude-test',stop_reason:'end_turn',content:[],usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:50,cache_creation_input_tokens:5}}}];}

describe('provider adapters through transactional SQLite ingestion',()=>{
  it('observes preexisting and later Codex sessions, follows native names, and survives restart without inflation',async()=>{
    const f=await fixture('codex');let adapter=createCodexAdapter();
    const file=await f.write(`sessions/2026/11/03/rollout-${nativeA}.jsonl`,codexRecords(nativeA));
    const index=await f.write('session_index.jsonl',[{id:nativeA,thread_name:'Existing native Codex',updated_at:started}]);
    let result=await adapter.poll(f.context);const original=result.sessions.find(session=>session.nativeId===nativeA)!;
    expect(original).toBeDefined();expect(original.name).toBe('Existing native Codex');expect(original.usage.value?.total).toBe(120);expect(original.runtime.loaded).toBe(false);
    await fs.appendFile(file,JSON.stringify(codexRecords(nativeA).at(-1))+'\n');await f.write(`sessions/flat-${nativeB}.jsonl`,codexRecords(nativeB));await fs.appendFile(index,JSON.stringify({id:nativeA,thread_name:'Renamed native Codex',updated_at:'2026-11-03T12:01:00Z'})+'\n');f.advance();
    result=await adapter.poll(f.context);expect(result.sessions.filter(session=>session.cwd==='/same/project')).toHaveLength(2);expect(result.sessions.find(session=>session.nativeId===nativeA)).toMatchObject({id:original.id,name:'Renamed native Codex'});expect(result.sessions.find(session=>session.nativeId===nativeA)?.usage.value?.total).toBe(120);
    await adapter.close?.();await f.restart();adapter=createCodexAdapter();result=await adapter.poll(f.context);expect(result.sessions.find(session=>session.nativeId===nativeA)?.usage.value?.total).toBe(120);await adapter.close?.();
    expect(f.commands.every(args=>args.join(' ')==='app-server daemon version')).toBe(true);
    expect(f.forbiddenReads).toBe(0);
  });
  it('observes native Claude discovery/renames and replaces finalized response usage across restart',async()=>{
    const f=await fixture('claude');let adapter=createClaudeAdapter();
    const file=await f.write(`projects/actual-slug/${nativeA}.jsonl`,claudeRecords(nativeA));f.setListing([{sessionId:nativeA,pid:7,status:'idle',kind:'interactive',name:'Native Claude name',cwd:'/same/project'}]);
    let result=await adapter.poll(f.context);const original=result.sessions[0];expect(original.name).toBe('Native Claude name');expect(original.state.value).toBe('idle');expect(original.usage.value?.total).toBe(175);
    const revised=claudeRecords(nativeA).at(-1)!;revised.message={...revised.message!,usage:{input_tokens:100,output_tokens:40,cache_read_input_tokens:50,cache_creation_input_tokens:5}};
    await fs.appendFile(file,JSON.stringify(revised)+'\n');await f.write(`projects/actual-slug/${nativeB}.jsonl`,claudeRecords(nativeB));f.setListing([{sessionId:nativeA,pid:7,status:'busy',kind:'interactive',name:'Renamed native Claude',cwd:'/same/project'},{sessionId:nativeB,pid:8,status:'idle',kind:'interactive',name:'Second native Claude',cwd:'/same/project'}]);f.advance();
    result=await adapter.poll(f.context);expect(result.sessions).toHaveLength(2);expect(result.sessions.find(session=>session.nativeId===nativeA)).toMatchObject({id:original.id,name:'Renamed native Claude'});expect(result.sessions.find(session=>session.nativeId===nativeA)?.usage.value?.total).toBe(195);
    await f.restart();adapter=createClaudeAdapter();result=await adapter.poll(f.context);expect(result.sessions.find(session=>session.nativeId===nativeA)?.usage.value?.total).toBe(195);
    expect(f.commands.every(args=>['agents --help','agents --json --all'].includes(args.join(' ')))).toBe(true);
    expect(await fs.readFile(path.join(f.source,'.credentials.json'),'utf8')).toBe('DO NOT READ');
    expect(f.forbiddenReads).toBe(0);
  });
});
