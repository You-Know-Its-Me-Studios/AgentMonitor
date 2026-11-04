import { createHash } from 'node:crypto';
import type { EvidenceItem, TaskEvidence } from '../shared/observer.js';
import { normalizeTimestamp } from '../shared/time.js';
import { redact } from './privacy.js';

/** Only bounded, public task evidence belongs here. Hidden reasoning and raw tool output never do. */
export interface TaskEvidenceState { nativeId: string; events: EvidenceItem[]; omitted: boolean }
export interface TaskSignal {
  kind: EvidenceItem['kind']; text: unknown; source: string; occurredAt: unknown;
  ingestedAt?: string; nativeId?: string; turnId?: string | null; status?: string;
  originalTimestamp?: string | number;
}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,24);
export function initialTaskEvidence(nativeId:string):TaskEvidenceState{return{nativeId,events:[],omitted:false};}
export function evidenceText(value:unknown,max=1600):string {
  if(typeof value!=='string')return'';
  return redact(value).replace(/\u0000/g,'').trim().slice(0,max);
}
export function instructionText(value:string,max=24000):string {
  const text=evidenceText(value,64000);if(text.length<=max)return text;
  const important=text.split('\n').filter(line=>/\b(?:must|never|required|requirements?|acceptance|verify|ensure|do not|don.t|preserve|current task|scope|finish|complete|test|build)\b/i.test(line));
  return text.slice(0,Math.floor(max*.55))+'\n[Long request condensed; explicit constraints retained]\n'+important.join('\n').slice(-Math.floor(max*.40));
}
export function genuineUserText(value:unknown):string|null {
  if(typeof value!=='string'||!value.trim())return null;const text=value.trim();
  if(/^(?:#\s*AGENTS\.md instructions|<environment_context>|<permissions|<INSTRUCTIONS>|<turn_aborted>|<system-reminder>|\[Request interrupted|<local-command)/i.test(text))return null;
  if(/^(?:Message Type:|Task name:|<user_instructions>|<collaboration_mode>)/i.test(text))return null;
  if(/^<[^>]+>[\s\S]*<\/[^>]+>\s*$/.test(text)&&!/\b(?:build|implement|fix|change|add|create|investigate|please|want)\b/i.test(text.replace(/<[^>]+>/g,'')))return null;
  return instructionText(text);
}
function objective(text:string):string {
  return text.split('\n').map(line=>line.replace(/^#{1,6}\s*/,'').trim()).find(line=>line.length>8&&!/^<|^\[Image|^```/.test(line))?.slice(0,500)??text.slice(0,500);
}
function userKind(text:string,prior:EvidenceItem|null,reportedComplete:boolean):'new'|'correction'|'status'|'pause' {
  const flat=text.replace(/^#{1,6}\s*/,'').trim();
  if(!prior && /^(?:continue|resume|go on|keep going|yes)[.!\s]*$/i.test(flat))return'status';
  if(/^(?:stop|pause|hold on|don.t (?:start|launch|run)|do not (?:start|launch|run))/i.test(flat))return'pause';
  if(/^(?:what(?:.s| is| are)|how(?:.s| is| are)|any (?:update|progress)|status\b|where (?:are we|is this)|are you (?:done|finished)|is it (?:done|ready)|can you (?:give|show).{0,30}(?:status|update))/i.test(flat)&&flat.length<500&&!/\b(?:must|instead|please (?:fix|change)|implement|add|remove)\b/i.test(flat))return'status';
  if(!prior)return'new';
  if(/\b(?:new (?:task|request|project)|next (?:task|project)|switch (?:tasks|to)|unrelated (?:task|request))\b/i.test(flat.slice(0,180)))return'new';
  if(/^(?:no\b|actually\b|instead\b|also\b|keep\b|continue\b|resume\b|yes\b|thanks\b|that\b|this\b|it\b|don.t\b|do not\b)/i.test(flat))return'correction';
  const imperative=/^(?:please\s+)?(?:build|create|implement|design|research|investigate|analyze|write|generate|refactor|fix|update|extend|replace|add)\b/i.test(flat);
  // A new multi-requirement implementation brief is a substantive request even when
  // an independently read tail no longer contains the preceding completed turn.
  if(imperative&&flat.length>1500)return'new';
  if(reportedComplete&&imperative&&(flat.length>180||/\n(?:[-*#]|\d+\.)/.test(text)))return'new';
  const refersBack=/\b(?:this|that|it|same|existing|current|still|earlier|instead|also)\b/i.test(flat.slice(0,350));
  const oldWords=new Set(prior.text.toLowerCase().match(/[a-z]{5,}/g)??[]),newWords=new Set(flat.toLowerCase().match(/[a-z]{5,}/g)??[]);
  const overlap=[...newWords].filter(word=>oldWords.has(word)).length;
  if(imperative&&!refersBack&&(reportedComplete||overlap<2))return'new';
  return'correction';
}
function chronological(a:EvidenceItem,b:EvidenceItem){return a.occurredAt.localeCompare(b.occurredAt)||a.id.localeCompare(b.id);}
export function isContextSummary(text:string):boolean {return /^This session is being continued from a previous conversation that ran out of context\./i.test(text.trim());}
function normalizedEvents(events:EvidenceItem[]):EvidenceItem[] {
  // Older cached Claude reducers treated automatic compaction summaries as new
  // user requests. Reinterpret those records without clearing ingestion history.
  const summaries=new Set(events.filter(e=>e.status==='user-input'&&isContextSummary(e.text)).map(e=>e.id.slice(0,e.id.lastIndexOf(':'))));
  return events.map(e=>summaries.has(e.id.slice(0,e.id.lastIndexOf(':')))?{...e,kind:'summary',status:'context-summary'}:e);
}
function resumesWork(event:EvidenceItem):boolean {return event.kind==='tool'&&['pending','in-flight'].includes(event.status??'')||event.kind==='progress'&&event.status==='public-update';}
function bounded(events:EvidenceItem[]):{events:EvidenceItem[];omitted:boolean} {
  const sorted=normalizedEvents(events).sort(chronological);let request:EvidenceItem|null=null,lastNew=0,complete=false;
  for(let i=0;i<sorted.length;i++){const e=sorted[i];if(e.status==='user-input'){const kind=userKind(e.text,request,complete);if(kind==='new'){request=e;lastNew=i;complete=false;}else if(kind==='pause')complete=true;}else if(e.status==='native-turn-complete'||e.status==='native-final'||e.kind==='summary'&&['public-final','final_answer'].includes(e.status??'')&&/\b(?:implemented|completed|finished|done)\b/i.test(e.text)&&!/(?:not|never|isn.t|haven.t|didn.t)\s+(?:yet\s+)?(?:complete|done|finished|implemented)/i.test(e.text))complete=true;else if(resumesWork(e))complete=false;}
  const current=sorted.filter((event,index)=>index>=lastNew||event.occurredAt===request?.occurredAt),priority=current.filter(e=>e.id===request?.id||e.status==='user-input'||e.status?.startsWith('user-input-continuation:')||e.kind==='plan'||e.kind==='blocker');
  const retained=new Map<string,EvidenceItem>();let bytes=0;
  const keep=(event:EvidenceItem)=>{if(retained.has(event.id))return;if(bytes+event.text.length>56000&&retained.size>0)return;retained.set(event.id,event);bytes+=event.text.length;};
  if(request){keep(request);const group=request.id.slice(0,request.id.lastIndexOf(':'));for(const e of priority)if(e.id.startsWith(group+':'))keep(e);}for(const e of priority.slice(-28))keep(e);for(const e of current.slice().reverse())if(retained.size<72)keep(e);
  return{events:[...retained.values()].sort(chronological),omitted:retained.size<current.length};
}
export function observeTaskEvidence(state:TaskEvidenceState,signal:TaskSignal):void {
  const occurredAt=normalizeTimestamp(signal.occurredAt);if(!occurredAt)return;
  const text=signal.status==='user-input'?genuineUserText(signal.text):evidenceText(signal.text,signal.kind==='plan'?4000:signal.kind==='blocker'?2400:signal.kind==='subagent'?1800:1600);
  if(!text)return;
  const group=`evidence:${hash(`${state.nativeId}\0${signal.nativeId??''}\0${signal.kind}\0${signal.status??''}\0${occurredAt}\0${text}`)}`;
  const chunks=signal.status==='user-input'?Array.from({length:Math.ceil(text.length/3500)},(_,index)=>text.slice(index*3500,(index+1)*3500)):[text];
  // Legacy presentation events and typed user messages can replay the same native request.
  if(signal.status==='user-input'&&state.events.some(existing=>existing.status==='user-input'&&existing.text===chunks[0]&&Math.abs(Date.parse(existing.occurredAt)-Date.parse(occurredAt))<10000))return;
  const additions:EvidenceItem[]=[];
  for(let index=0;index<chunks.length;index++){const id=`${group}:${String(index).padStart(2,'0')}`;if(state.events.some(event=>event.id===id))continue;const event:EvidenceItem={id,kind:index?'correction':signal.kind,occurredAt,ingestedAt:signal.ingestedAt??new Date().toISOString(),source:signal.source,text:chunks[index],turnId:signal.turnId??undefined,status:index?`user-input-continuation:${group}`:signal.status};if(typeof signal.originalTimestamp==='string'||typeof signal.originalTimestamp==='number')event.originalTimestamp=signal.originalTimestamp;additions.push(event);}
  const selection=bounded([...state.events,...additions]);state.events=selection.events;state.omitted ||=selection.omitted;
}
export function mergeTaskEvidence(a:TaskEvidenceState|undefined,b:TaskEvidenceState|undefined,nativeId:string):TaskEvidenceState {
  const events=new Map<string,EvidenceItem>();for(const state of [a,b])for(const event of state?.events??[]){const old=events.get(event.id);if(!old||event.ingestedAt<old.ingestedAt)events.set(event.id,event);}
  const selection=bounded([...events.values()]);return{nativeId,events:selection.events,omitted:!!a?.omitted||!!b?.omitted||selection.omitted};
}
export function taskEvidence(state:TaskEvidenceState|undefined,coverage:string):TaskEvidence|undefined {
  if(!state?.events.length)return undefined;
  const sorted=normalizedEvents(state.events).sort(chronological);let primary:EvidenceItem|null=null,start=0,revision=1,paused=false,reportedComplete=false,completed=false;
  const mapped:EvidenceItem[]=[];
  for(const event of sorted){
    if(event.status==='user-input'){
      const kind=userKind(event.text,primary,reportedComplete);
      if(kind==='new'){primary=event;start=mapped.length;revision=1;paused=false;reportedComplete=false;completed=false;mapped.push({...event,kind:'request'});}
      else {if(kind!=='status'){revision++;paused=kind==='pause';completed=false;if(paused)reportedComplete=true;}mapped.push({...event,kind:kind==='status'?'progress':'correction',status:kind==='status'?'user-status-question':kind==='pause'?'user-paused':'user-correction'});}
    }else{mapped.push(event);if(event.status==='native-turn-complete'||event.status==='native-final'){completed=true;reportedComplete=true;}else if(resumesWork(event)){completed=false;reportedComplete=false;}else if(event.kind==='summary'&&['public-final','final_answer'].includes(event.status??'')&&/\b(?:implemented|completed|finished|done)\b/i.test(event.text)&&!/(?:not|never|isn.t|haven.t|didn.t)\s+(?:yet\s+)?(?:complete|done|finished|implemented)/i.test(event.text))reportedComplete=true;}
  }
  const current=mapped.filter((event,index)=>index>=start||event.occurredAt===primary?.occurredAt),first=primary??current[0],last=current.at(-1)!;
  return{id:primary?`task:${hash(primary.id)}`:`task:unrecovered:${hash(state.nativeId)}`,revision,objective:primary?objective(primary.text):'Current task instructions have not been recovered',startedAt:first.occurredAt,lastActivityAt:last.occurredAt,turnId:[...current].reverse().find(event=>event.turnId)?.turnId??null,state:primary?(paused?'paused':completed?'complete':'active'):'unknown',items:current,coverage:`${coverage}${state.omitted?' Earlier low-priority public evidence was condensed.':''}${primary?' Task boundaries follow explicit user requests; completion is reported by native turn/final evidence, not independently verified.':' Task instructions are unavailable; further source backfill is required.'}`,instructionsRecovered:!!primary};
}
export function outputEvidence(value:unknown):string {
  if(typeof value!=='string')return'';
  const lines=redact(value).split(/\r?\n/).filter(line=>/\b(?:tests?|passed|failed|errors?|warnings?|built in|build (?:succeeded|failed)|typecheck|duration|exit code|blocked|permission|timed out)\b/i.test(line));
  return lines.slice(-8).map(line=>line.trim().slice(0,220)).join('\n').slice(0,1400);
}
export function isObserverWorkspace(cwd:unknown):boolean{return typeof cwd==='string'&&/[\\/]\.agent-monitor[\\/]observer(?:[\\/]|$)/i.test(cwd);}
