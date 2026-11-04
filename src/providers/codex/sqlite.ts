import { DatabaseSync } from 'node:sqlite';
import type { AdapterContext } from '../../shared/adapter.js';
import { iso, string } from './parser.js';

export interface ThreadMetadata { id: string; rolloutPath: string | null; name: string | null; title: string | null; model: string | null; effort: string | null; cwd: string | null; branch: string | null; startedAt: string | null; lastAt: string | null; archived: boolean; parent: string | null; source?: string }
function columns(db: DatabaseSync, table: string): Set<string> { return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(x => x.name)); }
const SELECT_COLUMNS = ['id','rollout_path','name','title','model','reasoning_effort','cwd','git_branch','created_at','updated_at','created_at_ms','updated_at_ms','archived','source','attached_thread_parent_id'];
function normalize(row: any): ThreadMetadata {
  let parent: string | null = null;
  if (typeof row.source === 'string' && row.source.startsWith('{')) { try { const source = JSON.parse(row.source); parent = string(source.subagent?.thread_spawn?.parent_thread_id ?? source.subAgent?.threadSpawn?.parentThreadId); } catch { /* Unknown source variant does not establish ancestry. */ } }
  return { id: row.id, rolloutPath: string(row.rollout_path), name: string(row.name), title: string(row.title), model: string(row.model), effort: string(row.reasoning_effort), cwd: string(row.cwd), branch: string(row.git_branch), startedAt: iso(row.created_at_ms ?? row.created_at), lastAt: iso(row.updated_at_ms ?? row.updated_at), archived: row.archived === 1, parent };
}
export async function readMetadata(context: AdapterContext): Promise<{ threads: ThreadMetadata[]; available: boolean; errors: number }> {
  const dirs = new Set([context.root]);
  const conf = await context.io.text(context.io.join(context.root,'config.toml'),256 * 1024);
  // Deliberately parse only a scalar path, never unrelated config or credential material.
  const configured = conf?.match(/^\s*sqlite_home\s*=\s*["']([^"']+)["']/m)?.[1]; if (configured) dirs.add(configured);
  if (!context.namespace.startsWith('wsl:') && process.env.CODEX_SQLITE_HOME) dirs.add(process.env.CODEX_SQLITE_HOME);
  const candidates: string[] = [];
  for (const dir of dirs) for (const file of await context.io.list(dir)) if (!file.isDirectory && /\.(sqlite|sqlite3|db)$/.test(file.path)) candidates.push(file.path);
  let available = false, errors = 0; const threads = new Map<string,ThreadMetadata>();
  for (const path of candidates) {
    if (context.namespace.startsWith('wsl:')) {
      const script = `import sqlite3,json,sys,pathlib\nc=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True,timeout=0.1)\nc.execute('pragma query_only=on')\ncols={r[1] for r in c.execute('pragma table_info(threads)')}\nwanted=json.loads(sys.argv[2])\nprint(json.dumps([dict(zip([x for x in wanted if x in cols],r)) for r in c.execute('select '+','.join([x for x in wanted if x in cols])+' from threads order by updated_at desc limit 20000')]) if {'id','rollout_path','cwd'}.issubset(cols) else 'null')\nc.close()`;
      const result = await context.command('python3',['-c',script,path,JSON.stringify(SELECT_COLUMNS)],4000); if (result.code !== 0) { errors++; continue; }
      try { const rows = JSON.parse(result.stdout); if (Array.isArray(rows)) { available = true; for (const row of rows) if (typeof row.id === 'string') threads.set(row.id,normalize(row)); } } catch { errors++; } continue;
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path,{readOnly:true}); db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100');
      const cols = columns(db,'threads'); if (!['id','rollout_path','cwd'].every(x => cols.has(x))) continue;
      const selected = SELECT_COLUMNS.filter(x => cols.has(x)); const order = cols.has('updated_at_ms') ? 'updated_at_ms' : cols.has('updated_at') ? 'updated_at' : 'id';
      // One bounded SELECT is a short read transaction; no provider DB writes or WAL maintenance.
      const rows = db.prepare(`SELECT ${selected.join(',')} FROM threads ORDER BY ${order} DESC LIMIT 20000`).all(); available = true;
      for (const row of rows as any[]) if (typeof row.id === 'string') { const value = normalize(row); const previous = threads.get(value.id); if (!previous || (value.lastAt ?? '') > (previous.lastAt ?? '')) threads.set(value.id,value); }
      if (cols.has('id')) {
        const edgeCols = columns(db,'thread_spawn_edges'); if (edgeCols.has('child_thread_id') && edgeCols.has('parent_thread_id')) for (const edge of db.prepare('SELECT child_thread_id,parent_thread_id FROM thread_spawn_edges LIMIT 30000').all() as any[]) { const child = threads.get(edge.child_thread_id); if (child) child.parent = edge.parent_thread_id; }
      }
    } catch { errors++; } finally { db?.close(); }
  }
  return { threads: [...threads.values()], available, errors };
}
