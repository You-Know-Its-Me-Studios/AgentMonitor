import { expect,it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CacheStore } from '../src/server/store.js';
import { NativeIO } from '../src/server/io.js';
import type { AdapterContext } from '../src/shared/adapter.js';
import { readMetadata } from '../src/providers/codex/sqlite.js';
import { initialCodexState,reduceCodex,sessionFromState } from '../src/providers/codex/parser.js';
import { canonicalHeader,mergeCodexObservations,readCodexTail } from '../src/providers/codex/tail.js';

// Explicit opt-in reads real histories without mutating them; ordinary tests remain isolated.
it.skipIf(!process.env.AGENT_MONITOR_LIVE_ROOT||!process.env.AGENT_MONITOR_LIVE_THREAD)('passively traces the selected real Codex source through prefix, current tail and task projection',async()=>{
  const root=process.env.AGENT_MONITOR_LIVE_ROOT!,nativeId=process.env.AGENT_MONITOR_LIVE_THREAD!,temporary=await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-live-source-'));
  const store=new CacheStore(path.join(temporary,'own-cache.sqlite')),io=new NativeIO(),now=new Date().toISOString();
  const context:AdapterContext={root,namespace:`native:${root}`,now,io,ingest:(file,initial,reduce)=>store.ingest('live-source-investigation',io,file,initial,reduce),command:async()=>({stdout:'',stderr:'Runtime probe intentionally omitted in source-only check',code:1}),processIdentity:async()=>null};
  try{
    const metadata=await readMetadata(context),row=metadata.threads.find(thread=>thread.id===nativeId);expect(row?.rolloutPath).toBeTruthy();
    const info=await io.stat(row!.rolloutPath!),header=await canonicalHeader(context,info!,nativeId);expect(header).toBeTruthy();
    const prefix=await context.ingest(row!.rolloutPath!,()=>initialCodexState(nativeId),(state,record,meta)=>reduceCodex(state,record,{...meta,ingestedAt:now}));
    const tail=await readCodexTail(context,info!,nativeId,header),merged=mergeCodexObservations(prefix.state,tail),session=sessionFromState(merged,context.namespace,'real source-only passive check',now);
    expect(session.nativeId).toBe(nativeId);expect(session.task?.instructionsRecovered).toBe(true);expect(session.task!.items.some(item=>item.kind==='request')).toBe(true);expect(session.task!.items.every(item=>item.text.length<=3500)).toBe(true);expect(Date.parse(session.task!.lastActivityAt)<=Date.now()+1000).toBe(true);if(process.env.AGENT_MONITOR_EXPECT_TASK_PREFIX)expect(session.task!.objective.startsWith(process.env.AGENT_MONITOR_EXPECT_TASK_PREFIX)).toBe(true);
    expect(session.lastActivityAt!>=prefix.state.lastAt!).toBe(true);expect(session.usage.value?.total).toBeGreaterThan(0);expect(session.task!.items.some(item=>item.kind==='tool'||item.kind==='result'||item.kind==='subagent')).toBe(true);
    console.log(JSON.stringify({passiveSourceTrace:{nativeId,sourceBytes:info!.size,prefixComplete:prefix.complete,prefixLastActivity:prefix.state.lastAt,tailLastActivity:tail.lastAt,mergedLastActivity:session.lastActivityAt,taskStartedAt:session.task!.startedAt,taskState:session.task!.state,instructionsRecovered:session.task!.instructionsRecovered,objectiveLength:session.task!.objective.length,expectedObjectivePrefixMatched:!process.env.AGENT_MONITOR_EXPECT_TASK_PREFIX||session.task!.objective.startsWith(process.env.AGENT_MONITOR_EXPECT_TASK_PREFIX),taskEvidenceItems:session.task!.items.length,scopeRevision:session.task!.revision,evidenceKinds:[...new Set(session.task!.items.map(item=>item.kind))],model:session.model.value,effort:session.effort.value,responseUsageSlices:session.usageBreakdown?.length,usageTotal:session.usage.value?.total}}));
  }finally{store.close();await fs.rm(temporary,{recursive:true,force:true});}
},30000);
