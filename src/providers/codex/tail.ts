import type { AdapterContext, FileInfo } from '../../shared/adapter.js';
import { mergeTaskEvidence } from '../../server/task-evidence.js';
import { initialCodexState, reduceCodex, type CodexState } from './parser.js';
import { readRecentUserItems } from './sqlite.js';

export async function canonicalHeader(context:AdapterContext,file:FileInfo,id:string):Promise<any|null>{
  const bytes=await context.io.read(file.path,0,Math.min(file.size,512*1024));const end=bytes.indexOf(10);if(end<0)return null;
  try{const record=JSON.parse(bytes.subarray(0,end).toString('utf8').replace(/^\uFEFF/,''));return record.type==='session_meta'&&record.payload?.id===id?record:null;}catch{return null;}
}
export async function readCodexTail(context:AdapterContext,file:FileInfo,id:string,header:any,budget=4*1024*1024):Promise<CodexState>{
  const state=initialCodexState(id);reduceCodex(state,header,{source:file.path,offset:0,generation:0,ingestedAt:context.now});
  const length=Math.min(file.size,budget),offset=file.size-length,bytes=await context.io.read(file.path,offset,length);
  const after=await context.io.stat(file.path);if(!after||after.identity!==file.identity||after.size<file.size)throw new Error('Rollout changed generation during tail read');
  const records=bytes.toString('utf8').split('\n');if(offset>0)records.shift();if(bytes.at(-1)!==10)records.pop();
  let relative=0;for(const line of records){try{reduceCodex(state,JSON.parse(line),{source:file.path,offset:offset+relative,generation:0,ingestedAt:context.now});}catch{/* The transactional prefix reader diagnoses malformed complete records during backfill. */}relative+=Buffer.byteLength(line)+1;}
  // A bounded reverse-ordinal query recovers sparse native user items without scanning
  // intervening tool output or replaying usage. Its canonical IDs/times match typed rollouts.
  const requests=await readRecentUserItems(context,id);
  if(requests.length){const recovered=initialCodexState(id);reduceCodex(recovered,header,{source:file.path,offset:0,generation:0,ingestedAt:context.now});for(const record of requests){recovered.currentTurn=record.payload.turn_id;reduceCodex(recovered,record,{source:'Codex native paginated history',offset:0,generation:0,ingestedAt:context.now});}state.taskEvidence=mergeTaskEvidence(recovered.taskEvidence,state.taskEvidence,id);}
  return state;
}
export function mergeCodexObservations(prefix:CodexState,tail:CodexState):CodexState {
  const out=structuredClone(prefix),tailNewer=(tail.lastAt??'')>=(prefix.lastAt??'');
  for(const key of ['cwd','model','effort','branch'] as const){const atKey=`${key}At` as 'cwdAt'|'modelAt'|'effortAt'|'branchAt';if(tail[key]!==null&&(tail[atKey]??'')>=(prefix[atKey]??'')){out[key]=tail[key];out[atKey]=tail[atKey];}}
  for(const key of ['currentTurn','lastTask'] as const)if(tailNewer&&tail[key]!==null)out[key]=tail[key];
  out.lastAt=(tail.lastAt??'')>(prefix.lastAt??'')?tail.lastAt:prefix.lastAt;
  for(const[id,response]of Object.entries(tail.responses)){const old=out.responses[id];if(!old||response.at>=old.at)out.responses[id]=response;}
  if((tail.usageAt??'')>=(prefix.usageAt??'')){for(const key of ['modernTotal','legacyTotal','lastUsage','turnUsage','turnUsageQuality','usageAt']as const)if(tail[key]!==null&&tail[key]!==undefined)(out as any)[key]=tail[key];}
  if((tail.capacityAt??'')>=(prefix.capacityAt??'')&&tail.capacity!==null){out.capacity=tail.capacity;out.capacityAt=tail.capacityAt;}
  if(tail.quota&&(!out.quota||tail.quota.at>=out.quota.at))out.quota=tail.quota;
  for(const[id,tool]of Object.entries(tail.tools)){const old=out.tools[id];if(!old||tool.origin==='typed'&&old.origin!=='typed'||old.phase!=='finished'&&tool.phase==='finished'||(tool.endedAt??tool.at)>(old.endedAt??old.at))out.tools[id]=tool;}
  out.turnStarts={...prefix.turnStarts,...tail.turnStarts};out.durations={...prefix.durations,...tail.durations};out.completed={...prefix.completed,...tail.completed};
  const activities=new Map(prefix.activities.map(item=>[item.id,item]));for(const item of tail.activities){const old=activities.get(item.id);if(!old||item.at>old.at)activities.set(item.id,item);}out.activities=[...activities.values()].sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id)).slice(-80);
  out.taskEvidence=mergeTaskEvidence(prefix.taskEvidence,tail.taskEvidence,out.nativeId);if(tail.checklist&&tailNewer)out.checklist=tail.checklist;
  for(const[key,count]of Object.entries(tail.unknownTypes))out.unknownTypes[key]=Math.max(out.unknownTypes[key]??0,count);
  return out;
}
