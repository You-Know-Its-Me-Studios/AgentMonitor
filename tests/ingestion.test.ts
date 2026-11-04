import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CacheStore } from '../src/server/store.js';
import { NativeIO } from '../src/server/io.js';
import type { SourceIO } from '../src/shared/adapter.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-monitor-ingestion-'));
  cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'history.jsonl'),db=path.join(root,'cache.sqlite');
  let store=new CacheStore(db);cleanups.push(async()=>store.close());
  const io=new NativeIO(),initial=()=>({ids:{} as Record<string,number>,sum:0,texts:[] as string[]});
  const reduce=(state:ReturnType<typeof initial>,record:any)=>{if(typeof record.id!=='string'||state.ids[record.id]!==undefined)return;state.ids[record.id]=record.value??0;state.sum+=record.value??0;if(typeof record.text==='string')state.texts.push(record.text);};
  return{root,file,db,io,initial,reduce,get store(){return store;},async restart(){store.close();store=new CacheStore(db);},ingest:(source:SourceIO=io,budget?:number)=>store.ingest('fixture',source,file,initial,reduce,budget)};
}
function line(id:string,value:number,text?:string){return JSON.stringify({id,value,text})+'\n';}
describe('transactional byte ingestion lifecycle',()=>{
  it('keeps split JSON and split UTF-8 uncommitted until their newline arrives',async()=>{
    const f=await fixture(),record=Buffer.from(line('one',2,'split 🙂 café'));
    const emoji=record.indexOf(Buffer.from('🙂'));
    await fs.writeFile(f.file,record.subarray(0,emoji+2));
    let result=await f.ingest();expect(result.state.sum).toBe(0);expect(result.complete).toBe(false);
    await fs.appendFile(f.file,record.subarray(emoji+2,record.length-1));
    result=await f.ingest();expect(result.state.sum).toBe(0);
    await fs.appendFile(f.file,'\n');
    result=await f.ingest();expect(result.state.sum).toBe(2);expect(result.state.texts).toEqual(['split 🙂 café']);expect(result.errors).toBe(0);
  });
  it('handles LF, CRLF, BOM, empty lines and malformed complete records',async()=>{
    const f=await fixture();await fs.writeFile(f.file,'\uFEFF'+line('one',2).trimEnd()+'\r\n\r\nmalformed\n'+line('two',3));
    const result=await f.ingest();expect(result.state.sum).toBe(5);expect(result.errors).toBe(1);expect(result.complete).toBe(true);
  });
  it('does not reread an unchanged complete file and does not inflate replayed IDs',async()=>{
    const f=await fixture();await fs.writeFile(f.file,line('one',2));await f.ingest();
    let reads=0;const io:SourceIO={...f.io,join:(...parts)=>f.io.join(...parts),stat:file=>f.io.stat(file),list:file=>f.io.list(file),text:file=>f.io.text(file),async read(file,offset,length){reads++;return f.io.read(file,offset,length);}};
    const unchanged=await f.ingest(io);expect(unchanged.state.sum).toBe(2);expect(unchanged.bytesRead).toBe(0);expect(reads).toBe(0);
    await fs.appendFile(f.file,line('one',2)+line('two',3));expect((await f.ingest()).state.sum).toBe(5);
  });
  it('resets generation and normalized totals on truncation',async()=>{
    const f=await fixture();await fs.writeFile(f.file,line('one',200)+line('two',300));await f.ingest();
    await fs.writeFile(f.file,line('new',4));const result=await f.ingest();expect(result.generation).toBe(1);expect(result.state.sum).toBe(4);
  });
  it('resets on same-path replacement even when replacement is larger',async()=>{
    const f=await fixture();await fs.writeFile(f.file,line('one',2));await f.ingest();
    const replacement=path.join(f.root,'replacement');await fs.writeFile(replacement,line('new',7,'a bigger replacement record'));await fs.unlink(f.file);await fs.rename(replacement,f.file);
    const result=await f.ingest();expect(result.generation).toBe(1);expect(result.state.sum).toBe(7);
  });
  it('detects same-inode rewrites by prefix and checkpoint anchor',async()=>{
    const f=await fixture();await fs.writeFile(f.file,line('old',4));await f.ingest();
    await fs.writeFile(f.file,line('new',9));const result=await f.ingest();expect(result.generation).toBe(1);expect(result.state.sum).toBe(9);
  });
  it('reuses checkpoints across rename/archive and reads only appended data',async()=>{
    const f=await fixture();await fs.writeFile(f.file,line('one',2));await f.ingest();
    const archive=path.join(f.root,'archived.jsonl');await fs.rename(f.file,archive);await fs.appendFile(archive,line('two',3));
    const result=await f.store.ingest('fixture',f.io,archive,f.initial,f.reduce);expect(result.generation).toBe(0);expect(result.state.sum).toBe(5);expect(result.bytesRead).toBe(Buffer.byteLength(line('two',3)));
  });
  it('rolls back reducer state and checkpoint together on reducer failure',async()=>{
    const f=await fixture();await fs.writeFile(f.file,line('one',2));await f.ingest();await fs.appendFile(f.file,line('two',3));
    await expect(f.store.ingest('fixture',f.io,f.file,f.initial,(state,record)=>{f.reduce(state,record);throw new Error('synthetic reducer fault');})).rejects.toThrow('synthetic reducer fault');
    const saved=f.store.db.prepare('SELECT state FROM sources').get() as {state:string};expect(JSON.parse(saved.state).sum).toBe(2);
    const retried=await f.ingest();expect(retried.state.sum).toBe(5);expect(retried.bytesRead).toBe(Buffer.byteLength(line('two',3)));
  });
  it('restores normalized state and offsets after backend restart',async()=>{
    const f=await fixture();await fs.writeFile(f.file,line('one',2));await f.ingest();await f.restart();await fs.appendFile(f.file,line('two',3));
    const result=await f.ingest();expect(result.state.sum).toBe(5);expect(result.bytesRead).toBe(Buffer.byteLength(line('two',3)));
  });
  it('retains checkpoint on temporary locks or deletion and retries safely',async()=>{
    const f=await fixture();await fs.writeFile(f.file,line('one',2));await f.ingest();await fs.appendFile(f.file,line('two',3));
    const locked:SourceIO={...f.io,join:(...parts)=>f.io.join(...parts),stat:file=>f.io.stat(file),list:file=>f.io.list(file),text:file=>f.io.text(file),async read(){throw new Error('EPERM synthetic lock');}};
    await expect(f.ingest(locked)).rejects.toThrow('EPERM');expect((await f.ingest()).state.sum).toBe(5);
    await fs.unlink(f.file);const missing=await f.ingest();expect(missing.state.sum).toBe(5);expect(missing.complete).toBe(false);
  });
  it('rejects mixed generations when a file changes during the read',async()=>{
    const f=await fixture();await fs.writeFile(f.file,line('one',2));let changed=false;
    const racing:SourceIO={...f.io,join:(...parts)=>f.io.join(...parts),stat:file=>f.io.stat(file),list:file=>f.io.list(file),text:file=>f.io.text(file),async read(file,offset,length){const data=await f.io.read(file,offset,length);if(!changed && offset===0){changed=true;await fs.writeFile(file,line('replacement',99));}return data;}};
    await expect(f.ingest(racing)).rejects.toThrow('changed while reading');expect((await f.ingest()).state.sum).toBe(99);
  });
  it('bounds oversized records and resumes only after their terminating newline',async()=>{
    const f=await fixture();await fs.writeFile(f.file,'{"ignored":"'+'x'.repeat(17*1024*1024)+'"}\n'+line('valid',5));
    let result=await f.ingest();expect(result.bytesRead).toBeLessThanOrEqual(16*1024*1024);expect(result.state.sum).toBe(0);expect(result.errors).toBe(1);
    result=await f.ingest();expect(result.state.sum).toBe(5);expect(result.errors).toBe(1);expect(result.complete).toBe(true);
  });
  it('can checkpoint an empty file and then ingest its first record without inventing rotation',async()=>{
    const f=await fixture();await fs.writeFile(f.file,'');await f.ingest();await fs.appendFile(f.file,line('first',1));
    const result=await f.ingest();expect(result.state.sum).toBe(1);expect(result.generation).toBe(0);
  });
  it('redacts recognizable secrets before normalized reducer state reaches the cache',async()=>{
    const f=await fixture();await fs.writeFile(f.file,line('one',2,'Session title sk-syntheticsecretvalue123456'));
    const result=await f.ingest();expect(result.state.texts).toEqual(['Session title [redacted]']);
    const saved=f.store.db.prepare('SELECT state FROM sources').get() as {state:string};expect(saved.state).not.toContain('syntheticsecretvalue');
  });
});
