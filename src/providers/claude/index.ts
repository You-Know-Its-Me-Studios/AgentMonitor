import type { AdapterContext, AdapterResult, FileInfo, ProviderAdapter } from '../../shared/adapter.js';
import { emptySession, metric, sessionKey, type Diagnostic, type Session } from '../../shared/types.js';
import { claudeSession, cleanText, initialClaudeState, iso, reduceClaudeRecord, type ClaudeState } from './parser.js';
import { isObserverWorkspace, mergeTaskEvidence } from '../../server/task-evidence.js';
import { applyClaudeModelLimit, readClaudeModelLimits } from './context.js';

interface ExternalSession { sessionId?: string; id?: string; cwd?: string; kind?: string; startedAt?: number; pid?: number; status?: string; waitingFor?: string; state?: string; name?: string }
interface TranscriptFile { info: FileInfo; nativeId: string; parentNativeId: string | null }
function diag(ctx:AdapterContext,code:string,message:string,level:Diagnostic['level']='info'):Diagnostic{return{provider:'claude',namespace:ctx.namespace,level,code,message,at:ctx.now};}
function validExternal(value:unknown):value is ExternalSession {
  if(!value||typeof value!=='object')return false;
  const record=value as ExternalSession;
  return (typeof record.sessionId==='string'||typeof record.id==='string')&&(record.pid===undefined||Number.isInteger(record.pid))&&(record.status===undefined||typeof record.status==='string');
}
export function parseClaudeListing(text:string):ExternalSession[] {
  const result=JSON.parse(text);if(!Array.isArray(result)||!result.every(value=>value&&typeof value==='object'))throw new Error('Listing did not return a session array');
  return result.filter(validExternal);
}
function base(path:string){return path.split(/[\\/]/).at(-1)??path;}
async function safeList(ctx:AdapterContext,path:string,diagnostics:Diagnostic[]):Promise<FileInfo[]>{try{return await ctx.io.list(path);}catch{diagnostics.push(diag(ctx,'claude-source-unreadable','A Claude source directory is temporarily unavailable.','warning'));return[];}}

/** Enumerate real project directory names, never reconstruct native project slugs. */
export async function discoverClaudeTranscripts(ctx:AdapterContext,diagnostics:Diagnostic[]=[]):Promise<TranscriptFile[]> {
  const files:TranscriptFile[]=[];
  const projects=await safeList(ctx,ctx.io.join(ctx.root,'projects'),diagnostics);
  for(const project of projects.filter(file=>file.isDirectory)) {
    const entries=await safeList(ctx,project.path,diagnostics);
    for(const entry of entries) {
      const name=base(entry.path);
      if(!entry.isDirectory && /^[0-9a-f-]{16,}\.jsonl$/i.test(name))files.push({info:entry,nativeId:name.slice(0,-6),parentNativeId:null});
      if(entry.isDirectory && /^[0-9a-f-]{16,}$/i.test(name)) {
        const children=await safeList(ctx,ctx.io.join(entry.path,'subagents'),diagnostics);
        for(const child of children)if(!child.isDirectory && /^agent-[\w-]+\.jsonl$/i.test(base(child.path)))files.push({info:child,nativeId:`${name}/agent:${base(child.path).slice(6,-6)}`,parentNativeId:name});
      }
    }
  }
  return files;
}

/** Windows stores process birth identity as FILETIME; Linux registries may use start ticks. */
export function registryProcessStart(record:any):string|null {
  if(typeof record.procStart==='string' && /^\d{16,19}$/.test(record.procStart) && String(record.pidDomain??'').startsWith('win32:')) {
    try{return new Date(Number((BigInt(record.procStart)-116444736000000000n)/10000n)).toISOString();}catch{return null;}
  }
  return iso(record.processStartedAt??record.processStartTime);
}
export async function registryIsLive(record:any,ctx:AdapterContext):Promise<boolean>{
  if(!record||!Number.isInteger(record.pid)||typeof record.sessionId!=='string')return false;
  const expected=registryProcessStart(record);if(!expected)return false;
  const actual=await ctx.processIdentity(record.pid);if(!actual)return false;
  return /(?:^|[\\/])claude(?:\.exe)?$/i.test(actual.executable) && Math.abs(Date.parse(actual.startedAt)-Date.parse(expected))<=2;
}
export function registryConversationMatches(record:any,session:Session,sessions:Session[]):boolean {
  const processStart=registryProcessStart(record),activity=session.lastActivityAt;
  if(!processStart || !activity || Date.parse(activity)<Date.parse(processStart)-2000)return false;
  const cwd=(value:string|null|undefined)=>value?.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();
  if(!record.cwd || !session.cwd || cwd(record.cwd)!==cwd(session.cwd))return false;
  const registryAt=iso(record.updatedAt??record.statusUpdatedAt??record.startedAt);
  if(!registryAt)return false;
  const lastEvidence=Math.max(Date.parse(activity),Date.parse(registryAt));
  // A newer conversation can contradict a registry left behind by /clear or /resume.
  // With no supported listing, an ambiguous binding stays unknown instead of inventing liveness.
  return !sessions.some(other=>other.id!==session.id&&!other.parentId&&cwd(other.cwd)===cwd(session.cwd)&&other.lastActivityAt!==null&&Date.parse(other.lastActivityAt)>lastEvidence);
}

export function applyClaudeRuntime(session:Session,external:ExternalSession,now:string,source='claude agents --json'):void {
  if(typeof external.name==='string' && external.name.trim()){session.name=cleanText(external.name,4000)??session.name;session.nameSource='Native live name';}
  if(typeof external.cwd==='string'){session.cwd=cleanText(external.cwd,2048);session.project=session.cwd?.split(/[\\/]/).filter(Boolean).at(-1)??null;}
  const processAlive=typeof external.pid==='number' && typeof external.status==='string';
  const openTurn=['done','failed','stopped'].includes(external.state??'')?false:['working','blocked'].includes(external.state??'')?true:external.status==='busy'||external.status==='waiting'?true:external.status==='idle'?false:undefined;
  session.runtime={reachable:processAlive,loaded:processAlive,attachment:processAlive&&external.kind==='interactive'?'known':'unknown',pid:external.pid??null,processStartedAt:iso(external.startedAt),observedAt:now,openTurn,serverReachable:true};
  session.startedAt ||= iso(external.startedAt);
  let state:NonNullable<Session['state']['value']>='unknown';
  if(external.state==='done')state='complete';
  else if(external.state==='failed')state='error';
  else if(external.state==='stopped')state='complete';
  else if(external.status==='waiting')state=/permission|sandbox/i.test(external.waitingFor??'')?'approval':external.waitingFor==='input needed'?'input':'unknown';
  else if(external.state==='blocked')state='input';
  else if(external.status==='busy'||external.state==='working')state='running';
  else if(external.status==='idle')state='idle';
  const reason=external.waitingFor?`Native process is waiting for ${cleanText(external.waitingFor,200)}; ${state==='unknown'?'the exact task state is unavailable':'this waiting condition is explicitly reported'}.`:external.state?`Native task state is ${external.state}; ${processAlive?'its process remains live':'no live process was reported'}.`:external.status==='idle'?'Native listing reports an idle live process; idle does not mean the conversation or process exited.':external.status==='busy'?'Native listing reports a busy live process.':'Native listing did not report a recognized process or task state.';
  session.state=metric(state,source,'task state; process liveness is separate','reported',reason,now);
  if(openTurn===true && session.task?.state==='complete'){
    session.task.state='active';
    session.task.coverage+=' Native listing reports ongoing work after the last recorded final response; that response does not establish current completion.';
  }
  if(external.waitingFor)session.latestActivity=cleanText(external.waitingFor)??session.latestActivity;
  else if(external.state==='failed')session.latestActivity='Task ended with an error';
  else if(external.state==='stopped')session.latestActivity='Task stopped';
  if(session.startedAt && processAlive)session.timing.elapsedMs=metric(Math.max(0,Date.parse(now)-Date.parse(iso(external.startedAt)??session.startedAt)),source,'current process attachment elapsed','derived',undefined,now);
}

async function readTail(ctx:AdapterContext,file:TranscriptFile):Promise<ClaudeState>{
  const state=initialClaudeState(file.nativeId,file.info.path,file.parentNativeId);
  if(file.info.size<=1024*1024)return state;
  const length=Math.min(4*1024*1024,file.info.size),offset=file.info.size-length;
  const buffer=await ctx.io.read(file.info.path,offset,length);
  const after=await ctx.io.stat(file.info.path);
  if(!after || after.identity!==file.info.identity || after.size<file.info.size || after.mtimeMs!==file.info.mtimeMs)throw new Error('Transcript changed during tail observation; retry');
  const lines=buffer.toString('utf8').split('\n').slice(offset>0?1:0);
  // The last fragment is incomplete unless a newline has been committed.
  if(buffer.at(-1)!==10)lines.pop();
  for(const line of lines){try{reduceClaudeRecord(state,JSON.parse(line.replace(/\r$/,'')),{source:file.info.path,offset,generation:0,ingestedAt:ctx.now});}catch{/* Partial initial tail fragments are expected. */}}
  state.tailObservedAt=ctx.now;return state;
}
function mergeObservedTail(prefix:ClaudeState,tail:ClaudeState):ClaudeState {
  const merged=structuredClone(prefix);
  for(const field of ['cwd','branch','lastActivityAt','model','effort','explicitTitle','generatedTitle','summary','currentTurn','checklist','nativeCost','tailObservedAt'] as const)if(tail[field]!==null)(merged as any)[field]=tail[field];
  // There may be an unread gap between prefix and tail. Never assign tail responses to an older prefix turn.
  if(tail.tailObservedAt && tail.currentTurn===null)merged.currentTurn=null;
  merged.startedAt=prefix.startedAt&&tail.startedAt?(prefix.startedAt<tail.startedAt?prefix.startedAt:tail.startedAt):prefix.startedAt??tail.startedAt;
  merged.firstPrompt??=tail.firstPrompt;merged.forkedFrom??=tail.forkedFrom;
  merged.contextClearedAt=[prefix.contextClearedAt,tail.contextClearedAt].filter((at):at is string=>Boolean(at)).sort().at(-1);
  if(tail.agentError&&(!prefix.agentError||tail.agentError.at>=prefix.agentError.at))merged.agentError=tail.agentError;
  for(const [id,response]of Object.entries(tail.responses))if(!merged.responses[id]||response.final||!merged.responses[id].final)merged.responses[id]=response;
  for(const[id,tool]of Object.entries(tail.tools)){const previous=merged.tools[id];merged.tools[id]=previous?.resultAt && (!tool.resultAt||previous.resultAt>=tool.resultAt)?previous:tool;}
  for(const[id,turn]of Object.entries(tail.turns))merged.turns[id]=merged.turns[id]?.durationMs!==null&&merged.turns[id]?.durationMs!==undefined?merged.turns[id]:turn;
  const activities=new Map(prefix.activities.map(activity=>[activity.id,activity]));for(const activity of tail.activities)activities.set(activity.id,activity);merged.activities=[...activities.values()].sort((a,b)=>a.at.localeCompare(b.at)).slice(-80);
  for(const[kind,count]of Object.entries(tail.unknown))merged.unknown[kind]=Math.max(merged.unknown[kind]??0,count);
  if(tail.checklist && tail.checklistTiming){merged.checklistTiming=tail.checklistTiming;}
  merged.taskEvidence=mergeTaskEvidence(prefix.taskEvidence,tail.taskEvidence,merged.nativeId);
  return merged;
}

export function createClaudeAdapter():ProviderAdapter {
  let modelLimits:Awaited<ReturnType<typeof readClaudeModelLimits>>=[],nextCatalogAt=0;
  let supported=false,allSupported=false,capability:'pending'|'supported'|'unsupported'|'retrying'='pending',helpFailures=0,nextHelpAt=0;
  let nextListingAt=0,listFailures=0,lastListingObservedAt:string|null=null,cachedListing:ExternalSession[]=[],listingHealthy=false;
  let lastFilesAt=0,cachedFiles:TranscriptFile[]=[];
  const transcriptCache=new Map<string,{session:Session;complete:boolean;size:number;mtimeMs:number;identity:string;processedAt:number}>();
  const tailCache=new Map<string,{size:number;mtimeMs:number;identity:string;generation:number;state:ClaudeState}>();
  const excludedFiles=new Set<string>();
  return {provider:'claude',async poll(ctx):Promise<AdapterResult>{
    const diagnostics:Diagnostic[]=[];
    const failedFiles=new Set<string>();
    const now=Date.parse(ctx.now);
    if(now>=nextCatalogAt){
      nextCatalogAt=now+60000;
      try{modelLimits=await readClaudeModelLimits(ctx);}catch{diagnostics.push(diag(ctx,'claude-model-catalog-unreadable','Claude’s local model catalog is temporarily unreadable; context-limit discovery will retry.'));}
    }
    if(now>=nextHelpAt){
      const help=await ctx.command('claude',['agents','--help'],6000);
      if(help.code===0&&(/--json\b/.test(help.stdout)||/\b(?:Usage|Options):/i.test(help.stdout))){const previouslySupported=supported;supported=/--json\b/.test(help.stdout);allSupported=supported&&/--all\b/.test(help.stdout);capability=supported?'supported':'unsupported';if(!supported)listingHealthy=false;else if(!previouslySupported)nextListingAt=0;helpFailures=0;nextHelpAt=now+5*60000;}
      else{helpFailures++;capability='retrying';nextHelpAt=now+Math.min(60000,2000*2**Math.min(5,helpFailures-1));}
    }
    if(capability==='retrying')diagnostics.push(diag(ctx,'claude-capability-retry','Claude capability help is temporarily unavailable. Detection will retry with bounded backoff; this does not establish an unsupported CLI.','warning'));
    else if(capability==='unsupported')diagnostics.push(diag(ctx,'claude-external-list-unavailable','Successful native help does not advertise JSON session listing. Passive transcripts and validated registry hints remain available.'));
    if(supported && now>=nextListingAt){
      const result=await ctx.command('claude',['agents','--json',...(allSupported?['--all']:[])],7000);
      try{if(result.code!==0)throw new Error();cachedListing=parseClaudeListing(result.stdout);listingHealthy=true;lastListingObservedAt=ctx.now;listFailures=0;nextListingAt=now+3000;}
      catch{listingHealthy=false;listFailures++;nextListingAt=now+Math.min(60000,3000*2**Math.min(5,listFailures-1));}
    }
    if(supported&&!listingHealthy)diagnostics.push(diag(ctx,'claude-list-failed','Claude JSON listing is temporarily unavailable. Runtime verification will retry with bounded backoff; transcript collection continues independently.','warning'));
    if(!supported)diagnostics.push(diag(ctx,'claude-transcript-only','Claude is observed from transcripts. Recent file activity does not establish a live process.'));
    if(!cachedFiles.length || Date.parse(ctx.now)-lastFilesAt>=5000){cachedFiles=await discoverClaudeTranscripts(ctx,diagnostics);lastFilesAt=Date.parse(ctx.now);}
    const liveIds=new Set(cachedListing.map(row=>row.sessionId).filter(Boolean));
    const observerIds=new Set(cachedListing.filter(row=>isObserverWorkspace(row.cwd)).map(row=>row.sessionId));
    const files=cachedFiles.filter(file=>!observerIds.has(file.nativeId)&&!observerIds.has(file.parentNativeId??'')).sort((a,b)=>Number(liveIds.has(b.nativeId))-Number(liveIds.has(a.nativeId))||b.info.mtimeMs-a.info.mtimeMs);
    const sessions=new Map<string,Session>();let processed=0;
    const candidates=files.filter(file=>{const cached=transcriptCache.get(file.info.path);return !cached||!cached.complete||cached.size!==file.info.size||cached.mtimeMs!==file.info.mtimeMs||cached.identity!==file.info.identity;});
    const order=(a:TranscriptFile,b:TranscriptFile)=>(transcriptCache.get(a.info.path)?.processedAt??0)-(transcriptCache.get(b.info.path)?.processedAt??0)||b.info.mtimeMs-a.info.mtimeMs;
    const active=candidates.filter(file=>liveIds.has(file.nativeId)).sort(order).slice(0,4);
    const rest=candidates.filter(file=>!active.includes(file)).sort(order).slice(0,8-active.length);
    for(const file of [...active,...rest]){
      try{
        const currentInfo=await ctx.io.stat(file.info.path);if(!currentInfo)throw new Error('Transcript disappeared before read');
        const observedFile={...file,info:currentInfo};
        const result=await ctx.ingest(file.info.path,()=>initialClaudeState(file.nativeId,file.info.path,file.parentNativeId),(state,record,meta)=>reduceClaudeRecord(state,record,{...meta,ingestedAt:ctx.now}));
        // Bounded tail observation keeps metadata and recent finalized records current during historical backfill.
        let state=result.state;
        if(!result.complete){
          const tail=tailCache.get(file.info.path);
          if(tail && tail.size===currentInfo.size && tail.mtimeMs===currentInfo.mtimeMs && tail.identity===currentInfo.identity && tail.generation===result.generation)state=mergeObservedTail(result.state,tail.state);
          else {const recent=await readTail(ctx,observedFile);tailCache.set(file.info.path,{size:currentInfo.size,mtimeMs:currentInfo.mtimeMs,identity:currentInfo.identity,generation:result.generation,state:recent});state=mergeObservedTail(result.state,recent);}
        }else tailCache.delete(file.info.path);
        const session=claudeSession(state,ctx.namespace,ctx.now,result.complete);
        if(isObserverWorkspace(session.cwd)){excludedFiles.add(file.info.path);transcriptCache.delete(file.info.path);tailCache.delete(file.info.path);continue;}excludedFiles.delete(file.info.path);
        session.collection={lastCheckedAt:ctx.now,ingestedAt:result.bytesRead>0?ctx.now:transcriptCache.get(file.info.path)?.session.collection?.ingestedAt??null,evidenceAt:state.lastActivityAt,condition:result.complete?'current':'backfilling',reason:result.complete?'Native transcript reconciled':'Recent task evidence is observed while older history is backfilled'};
        if(result.errors)session.diagnostics.push(diag(ctx,'claude-json-errors',`${result.errors} malformed complete transcript records were skipped.`, 'warning'));
        transcriptCache.set(file.info.path,{session,complete:result.complete,size:currentInfo.size,mtimeMs:currentInfo.mtimeMs,identity:currentInfo.identity,processedAt:Date.parse(ctx.now)});
        processed++;
      }catch{failedFiles.add(file.info.path);const cached=transcriptCache.get(file.info.path);if(cached){const previous=cached.session.collection;cached.session.collection={lastCheckedAt:previous?.lastCheckedAt??new Date(lastFilesAt||now).toISOString(),ingestedAt:previous?.ingestedAt??null,evidenceAt:cached.session.lastActivityAt,condition:'unavailable',reason:'The latest transcript read failed. Last successful check, ingestion and native event timestamps are retained; runtime listing is a separate source.'};}diagnostics.push(diag(ctx,'claude-transcript-read-failed','A transcript is locked, removed, or temporarily unreadable. Last successful source timestamps are retained and collection will retry.','warning'));}
    }
    const present=new Set(files.map(file=>file.info.path));for(const path of transcriptCache.keys())if(!present.has(path)){transcriptCache.delete(path);tailCache.delete(path);}
    for(const file of files){
      if(excludedFiles.has(file.info.path))continue;
      const cached=transcriptCache.get(file.info.path);
      const session=cached?structuredClone(cached.session):emptySession('claude',ctx.namespace,file.nativeId,file.info.path,ctx.now);
      if(!cached){session.parentId=file.parentNativeId?sessionKey('claude',ctx.namespace,file.parentNativeId):null;session.latestActivity='Waiting for historical backfill';session.collection={lastCheckedAt:new Date(lastFilesAt||now).toISOString(),ingestedAt:null,evidenceAt:null,condition:failedFiles.has(file.info.path)?'unavailable':'backfilling',reason:failedFiles.has(file.info.path)?'The transcript was discovered but its latest read failed; no normalized source ingestion has succeeded yet.':'The transcript was discovered and is waiting for bounded historical backfill.'};session.diagnostics.push(diag(ctx,'claude-backfill-pending','Transcript discovered; historical metrics will be backfilled in a bounded batch.'));}
      const previous=sessions.get(session.id);if(!previous||(session.lastActivityAt??'')>(previous.lastActivityAt??''))sessions.set(session.id,session);
    }
    if(listingHealthy)for(const external of cachedListing){
      const nativeId=external.sessionId;if(!nativeId||isObserverWorkspace(external.cwd))continue;
      const id=sessionKey('claude',ctx.namespace,nativeId),session=sessions.get(id)??emptySession('claude',ctx.namespace,nativeId,'claude agents --json',ctx.now);
      applyClaudeRuntime(session,external,lastListingObservedAt??ctx.now);
      sessions.set(id,session);
    }
    if(!listingHealthy)for(const external of cachedListing){if(!external.sessionId||isObserverWorkspace(external.cwd))continue;const session=sessions.get(sessionKey('claude',ctx.namespace,external.sessionId));if(session&&external.name&&!/explicit/i.test(session.nameSource)){session.name=cleanText(external.name,4000)??session.name;session.nameSource='Last observed native name';}if(session)session.runtime.observedAt=lastListingObservedAt;}
    const pendingBackground=cachedListing.filter(external=>!external.sessionId&&external.id).length;
    if(pendingBackground)diagnostics.push(diag(ctx,'claude-background-conversation-pending',`${pendingBackground} background job${pendingBackground===1?' has':'s have'} not reported a native conversation ID yet. Conversations appear automatically when their identities are available.`));
    if(!supported || !listingHealthy){
      const registries=await safeList(ctx,ctx.io.join(ctx.root,'sessions'),diagnostics);
      for(const registry of registries.filter(file=>!file.isDirectory && /^\d+\.json$/.test(base(file.path)))){
        try{
          const text=await ctx.io.text(registry.path,32*1024);if(!text)continue;const record=JSON.parse(text);
          if(!await registryIsLive(record,ctx))continue;
          const session=sessions.get(sessionKey('claude',ctx.namespace,record.sessionId));
          // A registry left behind after /clear must not create a new conversation without transcript evidence.
          if(!session)continue;
          if(!registryConversationMatches(record,session,[...sessions.values()])){session.state=metric('unknown','native session registry','runtime','unavailable','The process exists, but its current conversation binding could not be confirmed',ctx.now);diagnostics.push(diag(ctx,'claude-registry-binding-uncertain','A registry process is alive, but transcript evidence cannot confirm its current conversation. Runtime state remains unknown.'));continue;}
          applyClaudeRuntime(session,record,ctx.now,'validated native session registry');
          session.runtime.processStartedAt=registryProcessStart(record);
          session.state.provenance.quality='derived';session.state.provenance.reason='Registry PID and process creation identity match; transcript identity confirmed';
        }catch{diagnostics.push(diag(ctx,'claude-registry-unreadable','A native session registry entry could not be validated.','info'));}
      }
    }
    for(const session of sessions.values())if(!session.runtime.reachable){const reason=supported&&!listingHealthy?'Supported Claude JSON listing is temporarily unavailable; live session state cannot be verified.':!supported?capability==='unsupported'?'Successful native help does not advertise JSON session listing; transcript evidence is separate from runtime verification.':'Claude runtime capability detection has not succeeded yet and will retry; transcript collection remains independent.':'Native listing did not report a live process for this conversation.';session.state.provenance.reason=`${session.state.provenance.reason??'Transcript evidence does not establish liveness.'} ${reason}`;if(session.collection)session.collection.reason=`${session.collection.reason}. ${reason}`;}
    for(const session of sessions.values())applyClaudeModelLimit(session,modelLimits,ctx.now);
    diagnostics.push(diag(ctx,'claude-capabilities',`${files.length} transcripts discovered; ${processed} incrementally refreshed this cycle. ${supported?'Supported JSON discovery enabled.':'Transcript discovery enabled.'} Subscription allowance is unavailable: ordinary session sources do not expose it.`));
    diagnostics.push(diag(ctx,'claude-status-line-unavailable','No supported captured status-line JSON payload is available to this adapter. A configured command is not a payload; the dashboard does not execute status-line commands or rewrite agent settings.'));
    return{sessions:[...sessions.values()],allowances:[],diagnostics};
  }};
}
