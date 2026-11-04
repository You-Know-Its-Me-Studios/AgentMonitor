import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import type { CommandResult, FileInfo, ProcessIdentity, SourceIO, SourceRoot } from '../shared/adapter.js';

const exec = promisify(execFile);
export async function command(executable: string, args: string[], timeoutMs = 8000, root?: SourceRoot): Promise<CommandResult> {
  let cmd = executable, argv = [...args];
  if (root?.distro) {
    const running = await command('wsl.exe', ['--list', '--running', '--quiet'], Math.min(timeoutMs, 4000));
    if (running.code !== 0 || !running.stdout.replace(/\0/g, '').split(/[\r\n]+/).map(x => x.trim()).includes(root.distro)) return { code: null, stdout: '', stderr: 'WSL distribution is not confirmed running; observation skipped' };
    cmd = 'wsl.exe'; argv = ['--distribution', root.distro, ...(root.user ? ['--user', root.user] : []), '--exec', 'env', `${root.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'}=${root.root}`, executable, ...args];
  } else if (process.platform === 'win32' && executable === 'codex') {
    const packageRoot = process.env.CODEX_MANAGED_PACKAGE_ROOT || path.join(process.env.APPDATA || '', 'npm/node_modules/@openai/codex');
    cmd = process.execPath; argv = [path.join(packageRoot, 'bin/codex.js'), ...args];
  } else if (process.platform === 'win32' && executable === 'claude') {
    const known = path.join(process.env.USERPROFILE || '', '.local/bin/claude.exe');
    if (await fs.stat(known).catch(() => null)) cmd = known;
  }
  try {
    const env = { ...process.env };
    if (root && !root.distro) env[root.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = root.root;
    const encoding = executable === 'wsl.exe' && args.includes('--list') ? 'utf16le' : 'utf8';
    const result = await exec(cmd, argv, { timeout: timeoutMs, maxBuffer: 24 * 1024 * 1024, windowsHide: true, encoding, env });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    // Some Windows restricted tokens allow child processes but deny anonymous pipes.
    // Capture the verified, read-only CLI listing through short-lived private files instead.
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') return commandViaFiles(cmd, argv, timeoutMs, root);
    const e = error as { stdout?: string; stderr?: string; message: string; code?: number };
    return { stdout: e.stdout || '', stderr: e.stderr || e.message, code: typeof e.code === 'number' ? e.code : null };
  }
}
async function commandViaFiles(cmd: string, args: string[], timeout: number, root?: SourceRoot): Promise<CommandResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-monitor-command-'));
  const out = path.join(dir, 'stdout'), err = path.join(dir, 'stderr');
  const outFd = openSync(out, 'wx', 0o600), errFd = openSync(err, 'wx', 0o600);
  try {
    const env = { ...process.env };
    if (root && !root.distro) env[root.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = root.root;
    const code = await new Promise<number | null>((resolve, reject) => {
      let child; try { child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', outFd, errFd], env }); } catch (e) { reject(e); return; }
      const timer = setTimeout(() => { child.kill(); resolve(null); }, timeout);
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('exit', code => { clearTimeout(timer); resolve(code); });
    });
    const max = 24 * 1024 * 1024;
    if ((await fs.stat(out)).size > max || (await fs.stat(err)).size > max) return { stdout: '', stderr: 'CLI response exceeded the observation limit', code: null };
    const encoding = cmd === 'wsl.exe' && args.includes('--list') ? 'utf16le' : 'utf8';
    return { code, stdout: await fs.readFile(out, encoding), stderr: await fs.readFile(err, encoding) };
  } catch { return { stdout: '', stderr: 'Read-only CLI command is unavailable in this environment', code: null }; }
  finally { closeSync(outFd); closeSync(errFd); await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined); }
}
export class NativeIO implements SourceIO {
  join(...parts: string[]): string { return path.join(...parts); }
  async stat(file: string): Promise<FileInfo | null> {
    try { const s = await fs.stat(file); return { path: file, size: s.size, mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs, identity: `${s.dev}:${s.ino}:${s.birthtimeMs}`, isDirectory: s.isDirectory() }; }
    catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code || '')) return null; throw e; }
  }
  async list(dir: string): Promise<FileInfo[]> {
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code || '')) return []; throw e; }
    const results: FileInfo[] = [];
    for (let i = 0; i < entries.length; i += 16) {
      const batch = await Promise.all(entries.slice(i, i + 16).filter(e => !e.isSymbolicLink()).map(e => this.stat(path.join(dir, e.name))));
      results.push(...batch.filter((x): x is FileInfo => x !== null));
    }
    return results;
  }
  async read(file: string, offset: number, length: number): Promise<Buffer> {
    const handle = await fs.open(file, 'r');
    try { const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, offset); return buffer.subarray(0, bytesRead); }
    finally { await handle.close(); }
  }
  async text(file: string, maxBytes = 2 * 1024 * 1024): Promise<string | null> {
    const s = await this.stat(file); if (!s || s.isDirectory) return null;
    return (await this.read(file, 0, Math.min(s.size, maxBytes))).toString('utf8');
  }
}

// All operations are explicit, bounded reads inside a distribution already confirmed running.
const WSL_HELPER = `import os,sys,json,base64
op,p=sys.argv[1:3]
def info(p):
 s=os.stat(p);return dict(path=p,size=s.st_size,mtimeMs=s.st_mtime*1000,birthtimeMs=getattr(s,'st_birthtime',0)*1000,identity=str(s.st_dev)+':'+str(s.st_ino),isDirectory=os.path.isdir(p))
try:
 if op=='stat':r=info(p)
 elif op=='list':r=[info(os.path.join(p,n)) for n in os.listdir(p) if not os.path.islink(os.path.join(p,n))][:20000]
 elif op=='read':
  with open(p,'rb') as f:f.seek(int(sys.argv[3]));r=base64.b64encode(f.read(min(int(sys.argv[4]),16777216))).decode()
 print(json.dumps(r))
except FileNotFoundError:print('null' if op=='stat' else '[]' if op=='list' else 'null')
`;
export class WslIO implements SourceIO {
  constructor(private root: SourceRoot) {}
  join(...parts: string[]): string { return path.posix.join(...parts); }
  private async call(op: string, file: string, ...args: string[]): Promise<any> {
    const result = await command('python3', ['-c', WSL_HELPER, op, file, ...args], 12000, this.root);
    if (result.code !== 0) throw new Error('WSL read unavailable; check the running distribution and Python 3');
    return JSON.parse(result.stdout);
  }
  async stat(file: string): Promise<FileInfo | null> { return this.call('stat', file); }
  async list(file: string): Promise<FileInfo[]> { return (await this.call('list', file)) || []; }
  async read(file: string, offset: number, length: number): Promise<Buffer> { const value = await this.call('read', file, String(offset), String(length)); return value ? Buffer.from(value, 'base64') : Buffer.alloc(0); }
  async text(file: string, maxBytes = 2 * 1024 * 1024): Promise<string | null> { const s = await this.stat(file); return s ? (await this.read(file, 0, Math.min(s.size, maxBytes))).toString('utf8') : null; }
}

export async function processIdentity(pid: number, root?: SourceRoot): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (root?.distro || process.platform !== 'win32') {
    const code = `import os,json,sys,datetime\np=int(sys.argv[1])\ntry:\n s=open('/proc/'+str(p)+'/stat').read().rsplit(')',1)[1].split();b=float([x.split()[1] for x in open('/proc/stat') if x.startswith('btime ')][0]);print(json.dumps(dict(pid=p,startedAt=datetime.datetime.fromtimestamp(b+int(s[19])/os.sysconf('SC_CLK_TCK'),datetime.timezone.utc).isoformat(),executable=os.readlink('/proc/'+str(p)+'/exe'))))\nexcept (OSError,ValueError):print('null')`;
    const r = await command('python3', ['-c', code, String(pid)], 4000, root); try { return JSON.parse(r.stdout); } catch { return null; }
  }
  const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { @{pid=$p.Id; startedAt=$p.StartTime.ToUniversalTime().ToString('o'); executable=$p.Path} | ConvertTo-Json -Compress }`;
  const r = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 5000);
  try { return JSON.parse(r.stdout); } catch { return null; }
}
