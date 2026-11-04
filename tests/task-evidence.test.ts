import { describe,expect,it } from 'vitest';
import { initialTaskEvidence,observeTaskEvidence,mergeTaskEvidence,taskEvidence,outputEvidence } from '../src/server/task-evidence.js';
import { initialCodexState,reduceCodex,sessionFromState } from '../src/providers/codex/parser.js';
import { initialClaudeState,reduceClaudeRecord,claudeSession } from '../src/providers/claude/parser.js';
import { sanitize } from '../src/server/privacy.js';

const start='2026-11-01T20:00:00.000Z',now='2026-11-04T01:20:00.000Z';
function user(state:ReturnType<typeof initialTaskEvidence>,text:string,at=start,id=text.slice(0,20)){observeTaskEvidence(state,{kind:'request',text,occurredAt:at,source:'synthetic transcript',nativeId:id,status:'user-input',ingestedAt:now,turnId:'turn'});}
describe('bounded current task evidence',()=>{
  it('keeps current task separate from a multi-day conversation and resets after a new substantive Update request',()=>{
    const state=initialTaskEvidence('session');user(state,'Build a local dashboard for normal existing agent sessions.');
    observeTaskEvidence(state,{kind:'summary',text:'The dashboard was implemented.',occurredAt:'2026-11-02T20:00:00Z',source:'synthetic',status:'public-final'});
    observeTaskEvidence(state,{kind:'summary',text:'Native turn completed',occurredAt:'2026-11-02T20:00:01Z',source:'synthetic',status:'native-turn-complete'});
    const original=taskEvidence(state,'complete')!;expect(original.state).toBe('complete');
    user(state,'Stop launching browsers or other applications.','2026-11-02T20:01:00Z');expect(taskEvidence(state,'complete')?.state).toBe('paused');
    user(state,'Update the existing Agent Monitor with a current-task observer.\n- Recover latest requirements and corrections.\n- Use provider-native evidence, preserve model/effort and current task identity.\n- Keep observer work out of normal session tabs.','2026-11-03T23:00:00Z');
    const current=taskEvidence(state,'complete')!;expect(current.id).not.toBe(original.id);expect(current.objective).toContain('Update the existing Agent Monitor');expect(current.startedAt).toBe('2026-11-03T23:00:00.000Z');expect(current.state).toBe('active');
  });
  it('preserves identity across corrections and status questions while only scope changes revise the task',()=>{
    const state=initialTaskEvidence('session');user(state,'Implement automatic discovery and accurate session metrics.');const initial=taskEvidence(state,'complete')!;
    user(state,'Actually, preserve native session names and do not infer liveness from file modification time.','2026-11-01T20:01:00Z');const corrected=taskEvidence(state,'complete')!;expect(corrected.id).toBe(initial.id);expect(corrected.revision).toBe(initial.revision+1);
    user(state,'What is the current status?','2026-11-01T20:02:00Z');observeTaskEvidence(state,{kind:'progress',text:'The parser is being updated.',occurredAt:'2026-11-01T20:03:00Z',source:'synthetic',nativeId:'public-update'});
    const current=taskEvidence(state,'complete')!;expect(current.id).toBe(initial.id);expect(current.revision).toBe(corrected.revision);expect(current.items.some(item=>item.status==='user-status-question')).toBe(true);
  });
  it('keeps long instructions and final acceptance constraints through cache sanitization in <=3500-character chunks',()=>{
    const state=initialTaskEvidence('session');const text='Implement the following dashboard requirements.\n'+'A meaningful bounded requirement.\n'.repeat(450)+'\nFinal acceptance: preserve UTF-8 split writes, native naming, latest metadata and exact final acceptance sentinel.';
    user(state,text);const cached=sanitize(state),task=taskEvidence(cached,'complete')!;expect(task.items.every(item=>item.text.length<=3500)).toBe(true);expect(task.items.map(item=>item.text).join('')).toContain('exact final acceptance sentinel');expect(task.revision).toBe(1);expect(task.instructionsRecovered).toBe(true);
  });
  it('deduplicates replay/rename and keeps occurrence/original time separate from ingestion',()=>{
    const state=initialTaskEvidence('session'),signal={kind:'request' as const,text:'Build a meaningful feature.',occurredAt:'2026-11-03T20:02:00-05:00',originalTimestamp:'2026-11-03T20:02:00-05:00',ingestedAt:now,source:'original/file',nativeId:'user-native',status:'user-input'};
    observeTaskEvidence(state,signal);observeTaskEvidence(state,{...signal,source:'archived/file',ingestedAt:'2026-11-04T02:00:00Z'});
    const task=taskEvidence(state,'complete')!;expect(task.items).toHaveLength(1);expect(task.items[0]).toMatchObject({occurredAt:'2026-11-04T01:02:00.000Z',originalTimestamp:signal.originalTimestamp,ingestedAt:now});
  });
  it('merges prefix instructions with recent tail corrections without inventing recovered instructions from tool counts',()=>{
    const prefix=initialTaskEvidence('session'),tail=initialTaskEvidence('session');user(prefix,'Implement the source adapter.');user(tail,'Actually, do not launch a replacement daemon.','2026-11-04T01:00:00Z');
    observeTaskEvidence(tail,{kind:'tool',text:'Read-only source inspection returned.',occurredAt:'2026-11-04T01:01:00Z',source:'synthetic',nativeId:'tool'});
    const merged=taskEvidence(mergeTaskEvidence(prefix,tail,'session'),'partial history')!;expect(merged.instructionsRecovered).toBe(true);expect(merged.objective).toBe('Implement the source adapter.');expect(merged.items.some(item=>item.text.includes('replacement daemon'))).toBe(true);
    const onlyTools=initialTaskEvidence('missing');observeTaskEvidence(onlyTools,{kind:'tool',text:'Tool invocation observed',occurredAt:now,source:'synthetic'});expect(taskEvidence(onlyTools,'partial')?.instructionsRecovered).toBe(false);
  });
  it('does not infer completion from ordinary progress and exposes native reported completion honestly',()=>{
    const state=initialTaskEvidence('session');user(state,'Implement the missing feature.');observeTaskEvidence(state,{kind:'progress',text:'I implemented one parser and will continue with integration.',occurredAt:'2026-11-01T20:01:00Z',source:'synthetic'});expect(taskEvidence(state,'complete')?.state).toBe('active');
    observeTaskEvidence(state,{kind:'summary',text:'Native turn completed',occurredAt:'2026-11-01T20:02:00Z',source:'synthetic',status:'native-turn-complete'});const task=taskEvidence(state,'complete')!;expect(task.state).toBe('complete');expect(task.coverage).toContain('not independently verified');
  });
  it('discards setup envelopes and hidden provider reasoning while retaining plans/results',()=>{
    const codex=initialCodexState('native');reduceCodex(codex,{type:'session_meta',timestamp:start,payload:{id:'native',timestamp:start}});
    reduceCodex(codex,{type:'response_item',timestamp:start,payload:{type:'message',role:'user',content:[{type:'input_text',text:'# AGENTS.md instructions\n<INSTRUCTIONS>private setup rules</INSTRUCTIONS>'}]}});
    reduceCodex(codex,{type:'response_item',timestamp:start,payload:{type:'reasoning',summary:[{text:'Hidden thought sentinel'}]}});
    reduceCodex(codex,{type:'response_item',timestamp:start,payload:{type:'message',role:'user',content:[{type:'input_text',text:'Implement the adapter correctly.'}]}});
    reduceCodex(codex,{type:'response_item',timestamp:start,payload:{type:'function_call',call_id:'plan',name:'update_plan',arguments:JSON.stringify({plan:[{step:'Read source metadata',status:'completed'},{step:'Fix accounting',status:'in_progress'}]})}});
    const task=sessionFromState(codex,'fixture','synthetic',now).task!;expect(task.instructionsRecovered).toBe(true);expect(task.items.some(item=>item.kind==='plan')).toBe(true);expect(JSON.stringify(task)).not.toContain('Hidden thought sentinel');expect(JSON.stringify(task)).not.toContain('private setup rules');
    expect(outputEvidence('private full output\nTests 12 passed\nsecret=syntheticsecretvalue')).toBe('Tests 12 passed');
  });
  it('records Claude current public instructions and final evidence without thinking blocks',()=>{
    const state=initialClaudeState('session','synthetic');reduceClaudeRecord(state,{type:'user',sessionId:'session',uuid:'user',timestamp:start,message:{content:'Implement the source reader and meaningful tests.'}});
    reduceClaudeRecord(state,{type:'assistant',sessionId:'session',timestamp:'2026-11-01T20:01:00Z',message:{id:'response',model:'claude-test',stop_reason:'end_turn',content:[{type:'thinking',thinking:'Hidden Claude thought sentinel'},{type:'text',text:'Implemented the reader. Tests passed.'}],usage:{input_tokens:10,output_tokens:20}}});
    const task=claudeSession(state,'fixture',now).task!;expect(task.instructionsRecovered).toBe(true);expect(task.state).toBe('complete');expect(JSON.stringify(task)).not.toContain('Hidden Claude thought sentinel');
  });
});
