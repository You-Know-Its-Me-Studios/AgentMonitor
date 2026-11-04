import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { IngestResult, RecordMeta, SourceIO } from '../shared/adapter.js';
import type { Snapshot } from '../shared/types.js';
import { sanitize } from './privacy.js';

interface Checkpoint { identity: string; generation: number; offset: number; prefix: string; prefixLength: number; anchor: string; state: string; errors: number; dropping: number; fileSize: number; mtimeMs: number }
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
export class CacheStore {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS sources (key TEXT PRIMARY KEY, namespace TEXT NOT NULL, path TEXT NOT NULL, identity TEXT NOT NULL, generation INTEGER NOT NULL, offset INTEGER NOT NULL, prefix TEXT NOT NULL, prefixLength INTEGER NOT NULL, anchor TEXT NOT NULL, state TEXT NOT NULL, errors INTEGER NOT NULL, updatedAt TEXT NOT NULL); CREATE INDEX IF NOT EXISTS sources_identity ON sources(namespace,identity); CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    const columns=new Set((this.db.prepare('PRAGMA table_info(sources)').all() as {name:string}[]).map(column=>column.name));
    for(const [name,sql] of [['dropping','INTEGER NOT NULL DEFAULT 0'],['fileSize','INTEGER NOT NULL DEFAULT -1'],['mtimeMs','REAL NOT NULL DEFAULT -1']] as const)if(!columns.has(name))this.db.exec(`ALTER TABLE sources ADD COLUMN ${name} ${sql}`);
  }
  snapshot(): Snapshot | null { const row = this.db.prepare("SELECT value FROM app_state WHERE key='snapshot'").get() as { value: string } | undefined; return row ? JSON.parse(row.value) : null; }
  saveSnapshot(snapshot: Snapshot): void { this.db.prepare("INSERT INTO app_state(key,value) VALUES ('snapshot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(sanitize(snapshot))); }
  readState<T>(key: string): T | null { const row = this.db.prepare('SELECT value FROM app_state WHERE key=?').get(key) as { value: string } | undefined; return row ? JSON.parse(row.value) : null; }
  writeState(key: string, value: unknown): void { this.db.prepare('INSERT INTO app_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(sanitize(value))); }
  listState<T>(prefix: string, limit = 50): T[] { return (this.db.prepare('SELECT value FROM app_state WHERE substr(key,1,?)=? ORDER BY rowid DESC LIMIT ?').all(prefix.length, prefix, Math.max(1, Math.min(limit, 100))) as { value: string }[]).map(row => JSON.parse(row.value)); }
  migrateReducers(version: string): void {
    if (this.readState<string>('reducer-version') === version) return;
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.exec('DELETE FROM sources'); this.writeState('reducer-version', version); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async ingest<T>(namespace: string, io: SourceIO, file: string, initial: () => T, reduce: (state: T, record: any, meta: RecordMeta) => void, budget = 4 * 1024 * 1024): Promise<IngestResult<T>> {
    const info = await io.stat(file);
    const key = `${namespace}\0${file}`;
    let old = this.db.prepare('SELECT * FROM sources WHERE key=?').get(key) as unknown as Checkpoint | undefined;
    if (!info) return { state: old ? JSON.parse(old.state) : initial(), complete: false, bytesRead: 0, generation: old?.generation || 0, errors: old?.errors || 0 };
    // Rename/archive retains a checkpoint when the operating system preserves file identity.
    if (!old) old = this.db.prepare('SELECT * FROM sources WHERE namespace=? AND identity=? ORDER BY updatedAt DESC LIMIT 1').get(namespace, info.identity) as unknown as Checkpoint | undefined;
    if(old && old.identity===info.identity && old.fileSize===info.size && old.mtimeMs===info.mtimeMs && old.offset>=info.size)return{state:JSON.parse(old.state),complete:true,bytesRead:0,generation:old.generation,errors:old.errors};
    let generation = old?.generation || 0;
    let offset = old?.offset || 0;
    let prefixLength = old?.prefixLength ?? Math.min(256, info.size);
    const prefix = digest(await io.read(file, 0, Math.min(prefixLength, info.size)));
    let preceding = offset && info.size >= offset ? await io.read(file, Math.max(0, offset - 256), Math.min(256, offset)) : Buffer.alloc(0);
    const anchor = preceding.length?digest(preceding):'';
    const replaced = !!old && (old.identity !== info.identity || info.size < offset || prefix !== old.prefix || (!!old.anchor && old.anchor !== anchor));
    let state: T;
    let errors: number;
    let dropping=old?.dropping===1;
    if (replaced) { generation++; offset = 0; state = initial(); errors = 0; prefixLength = Math.min(256, info.size); preceding=Buffer.alloc(0);dropping=false; }
    else { state = old ? JSON.parse(old.state) : initial(); errors = old?.errors || 0; }
    const expectedStartPrefix=replaced?digest(await io.read(file,0,prefixLength)):prefix;
    let buffer = await io.read(file, offset, Math.min(budget, Math.max(0, info.size - offset)));
    // A single large record can span a chunk. Grow only to a fixed ceiling, never the whole history.
    if (!dropping && buffer.length && buffer.indexOf(10) < 0 && info.size - offset > buffer.length && buffer.length < 16 * 1024 * 1024) buffer = await io.read(file, offset, Math.min(16 * 1024 * 1024, info.size - offset));
    let cursor = 0, committed = offset;
    for (;;) {
      const end = buffer.indexOf(10, cursor); if (end < 0) break;
      const line = buffer.subarray(cursor, end); const recordOffset = offset + cursor; cursor = end + 1; committed = offset + cursor;
      if(dropping){dropping=false;continue;}
      if (!line.length) continue;
      let record: unknown;
      const text=line.toString('utf8').replace(/^\uFEFF/, '').trim();if(!text)continue;
      try { record = JSON.parse(text); } catch { errors++; continue; }
      // A reducer failure aborts this update, retaining the previous committed state and offset.
      reduce(state, record, { offset: recordOffset, generation, source: file });
    }
    if(dropping){committed=offset+buffer.length;cursor=buffer.length;}
    else if (buffer.length === 16 * 1024 * 1024 && cursor === 0 && info.size - offset > buffer.length) { errors++; committed = offset + buffer.length;cursor=buffer.length;dropping=true; }
    const after=await io.stat(file);
    if(!after || after.identity!==info.identity || after.size<committed || (after.mtimeMs!==info.mtimeMs && after.size===info.size))throw new Error('Source changed while reading; checkpoint retained for retry');
    const finalPrefix=digest(await io.read(file,0,prefixLength));
    const expectedAnchor=committed?digest(Buffer.concat([preceding,buffer.subarray(0,cursor)]).subarray(-Math.min(256,committed))):'';
    const finalAnchor=committed?digest(await io.read(file,Math.max(0,committed-256),Math.min(256,committed))):'';
    // A rename is harmless; replacement or rewrites during a read must not mix generations.
    if(finalPrefix!==expectedStartPrefix || finalAnchor!==expectedAnchor)throw new Error('Source changed while reading; checkpoint retained for retry');
    const normalizedState=sanitize(state);
    const checkpoint = { identity: info.identity, generation, offset: committed, prefix: finalPrefix, prefixLength, anchor: finalAnchor, state: JSON.stringify(normalizedState), errors };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO sources(key,namespace,path,identity,generation,offset,prefix,prefixLength,anchor,state,errors,updatedAt,dropping,fileSize,mtimeMs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET identity=excluded.identity,generation=excluded.generation,offset=excluded.offset,prefix=excluded.prefix,prefixLength=excluded.prefixLength,anchor=excluded.anchor,state=excluded.state,errors=excluded.errors,updatedAt=excluded.updatedAt,dropping=excluded.dropping,fileSize=excluded.fileSize,mtimeMs=excluded.mtimeMs').run(key, namespace, file, checkpoint.identity, generation, committed, checkpoint.prefix, prefixLength, checkpoint.anchor, checkpoint.state, errors, new Date().toISOString(),dropping?1:0,info.size,info.mtimeMs);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { state:normalizedState, complete: committed >= after.size, bytesRead: buffer.length, generation, errors };
  }
  close(): void { this.db.close(); }
}
